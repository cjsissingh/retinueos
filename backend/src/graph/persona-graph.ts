import { StateGraph, END, START, interrupt, MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { generateText, type ModelMessage } from "ai";
import { PersonaStateAnnotation, type PersonaState } from "./state.js";
import type { ChatMessage } from "./chat-message.js";
import { toModelMessages } from "./message-mapping.js";
import { buildSystemPrompt, DELEGATION_FOLD_INSTRUCTION } from "./charter.js";
import type { ToolRegistry, ToolContext, ToolSpec, RiskClass, StagedRememberMemory } from "../tools/registry.js";
import { isGated, configFor, effectivePermission, storedPermission } from "../tools/autonomy.js";
import { originAllowsTool, type JobOrigin } from "../tools/job-origin-policy.js";
import type { AssignedToolConfig } from "../db/schema.js";
import type { DrizzleDb } from "../db/client.js";
import { resolveModel } from "../models/router.js";
import {
  boundedSummary,
  estimateThreadTokens,
  MAX_SUMMARY_CHARS,
  recentContextStart,
  summaryChunks,
  THREAD_TOKEN_THRESHOLD,
  threadContextSystemPrompt,
  threadSummarySystemPrompt,
  type ThreadHygieneStore,
  type ThreadSummary,
} from "./thread-hygiene.js";

export interface PersonaLike {
  modelProvider: string;
  modelName: string;
  systemPrompt: string;
  assignedToolIds: AssignedToolConfig[];
  voiceNotes?: string;
  boundaries?: string;
  scopeDescription?: string;
}

export type OnDelegate = (targetPersonaId: string, task: string) => Promise<Record<string, unknown>>;

/**
 * Fired once per non-delegation tool call after Phase 2 execution resolves
 * (or throws), gated or not — the dispatcher's hook for completing the
 * tool_calls audit lifecycle (see tool-calls/tool-call-repo.ts's
 * completeToolCallByCallId and 05-job-creation-and-audit-ui.md). `gated`
 * tells the dispatcher whether a pending_approval row already exists for
 * this callId (update it) or not (insert a fresh executed/failed row).
 */
export type OnToolExecuted = (info: {
  callId: string;
  toolId: string;
  riskClass: RiskClass;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  success: boolean;
  gated: boolean;
  externalEffectCompleted: boolean;
}) => Promise<void>;

/**
 * Fired once per real generateText() call — success or failure — so every
 * provider round-trip this persona makes has a durable record (see
 * models/model-call-repo.ts). Called unconditionally, before this function
 * returns or rethrows, so a call that fails or gets aborted is recorded too
 * (with `error` set, tokens/finishReason null) rather than only ever
 * recording successes.
 */
export type OnModelCall = (info: {
  provider: string;
  model: string;
  latencyMs: number;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  error: string | null;
}) => Promise<void>;

/** Only constructed by the dispatcher (the one place a db/persona/job triple
 *  is actually in scope) — see ToolContext's doc comment in registry.ts. */
export interface GraphRuntimeContext {
  db: DrizzleDb;
  personaId: string;
  jobId: string;
  /**
   * How this job started — consulted by job-origin-policy.ts's
   * originAllowsTool so a tool can require a human-present `user` job
   *. Required (not optional like the rest of this interface) on
   * purpose: a policy gate that silently defaults to the most permissive
   * origin on omission is the exact failure this ticket exists to prevent.
   * A caller that builds a real `runtime` must state the origin; a caller
   * that omits `runtime` entirely still gets the permissive "user" default
   * below (buildPersonaGraph's own direct test callers, none of which
   * exercise origin-restricted tools).
   */
  origin: JobOrigin;
  assertLease?: () => Promise<void>;
  stageWriteState?: (callId: string, key: string, content: string) => Promise<void>;
  stageDeleteState?: (callId: string, key: string) => Promise<void>;
  stageRememberMemory?: (callId: string, entry: StagedRememberMemory) => Promise<void>;
  stageForgetMemory?: (callId: string, label: string) => Promise<void>;
  signal?: AbortSignal;
  beginExternalEffect?: (callId: string) => Promise<void>;
  /**
   * Tool ids that already have a pending_approval/approved row on this job.
   * Always-allow can persist Allow on the persona before this resume
   * rebuilds the graph; those in-flight calls must still hit interrupt()
   * so LangGraph can apply the resume decision.
   */
  inFlightGatedToolIds?: string[];
}

// Hoisted out of buildPersonaGraph: it only ever reads its own `state`
// argument, never anything from the factory's closure, so there's no
// reason to recreate a fresh copy of it on every buildPersonaGraph call.
function routeAfterModel(state: PersonaState): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1];
  return last.toolCalls && last.toolCalls.length > 0 ? "tools" : END;
}

function selectThreadSummary(state: PersonaState, initial: ThreadSummary | undefined): ThreadSummary {
  const checkpoint = {
    summary: state.threadSummary,
    summarizedMessageCount: state.summarizedMessageCount,
  };
  const validAtSafeBoundary = (candidate: ThreadSummary | undefined): candidate is ThreadSummary => {
    if (!candidate) return false;
    const count = candidate.summarizedMessageCount;
    if (!Number.isSafeInteger(count) || count < 0 || candidate.summary.length > MAX_SUMMARY_CHARS) return false;
    if (count === 0) return true;
    // A summary may consume only a proper prefix and must leave the next
    // user turn intact. This is the same safe boundary recentContextStart()
    // emits, and prevents a spoofed/stale marker from slicing away a request.
    return Boolean(candidate.summary.trim()) && count < state.messages.length && state.messages[count]?.role === "user";
  };

  const validCheckpoint = validAtSafeBoundary(checkpoint) ? checkpoint : undefined;
  const validInitial = validAtSafeBoundary(initial) ? initial : undefined;
  if (!validCheckpoint) return validInitial ?? { summary: "", summarizedMessageCount: 0 };
  if (!validInitial) return validCheckpoint;
  // A graph node that advanced farther during this invocation is newest.
  // At the same boundary, persona_memories is authoritative: its version
  // may have been repaired or superseded after this checkpoint was saved.
  if (validCheckpoint.summarizedMessageCount > validInitial.summarizedMessageCount) return validCheckpoint;
  return validInitial;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parses the arbitrary ToolSpec.run rejection boundary.
function boundedToolErrorDetail(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("detail" in error)) return undefined;
  const detail = error.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(detail)) > 16 * 1024) return undefined;
  } catch {
    return undefined;
  }
  // SAFETY: the guards above establish a non-array object and JSON
  // serialization establishes a bounded, plain audit payload.
  return detail as Record<string, unknown>;
}

export function buildPersonaGraph(
  persona: PersonaLike,
  registry: ToolRegistry,
  checkpointer?: BaseCheckpointSaver,
  onDelegate?: OnDelegate,
  runtime?: GraphRuntimeContext,
  onToolExecuted?: OnToolExecuted,
  onModelCall?: OnModelCall,
  // Pre-fetched by the dispatcher (see graph/memory-context.ts) rather than
  // fetched in here: this function stays synchronous, and the one DB read
  // it needs happens once per turn in driveTurn, same place `runtime`
  // itself gets constructed. Optional/defaulted to "" so every existing
  // direct caller (tests included) is unaffected.
  memoryContext = "",
  threadHygiene?: ThreadHygieneStore,
) {
  // Defaults to "user", the most permissive origin: direct callers (tests)
  // that build a graph without a full runtime see no origin-shaped
  // restriction, matching how an absent runtime already skips every other
  // runtime-only check in this function.
  const jobOrigin: JobOrigin = runtime?.origin ?? "user";
  const toolIds = persona.assignedToolIds
    .filter((c) => storedPermission(c) !== "blocked")
    .map((c) => c.toolId)
    // A tool this job's origin can't call is hidden from the model the same
    // way a Blocked tool is — Phase 2 of callTools below still refuses it
    // outright as defense-in-depth, but the model should never be offered
    // it in the first place.
    .filter((id) => !registry.has(id) || originAllowsTool(registry.get(id), jobOrigin));
  const canDelegate = toolIds.includes("delegate_to");
  const assembledSystemPrompt = buildSystemPrompt({
    systemPrompt: persona.systemPrompt,
    voiceNotes: persona.voiceNotes,
    boundaries: persona.boundaries,
    scopeDescription: persona.scopeDescription,
  });
  const withDelegationInstruction = canDelegate
    ? `${assembledSystemPrompt}\n\n${DELEGATION_FOLD_INSTRUCTION}`
    : assembledSystemPrompt;
  const systemPrompt = memoryContext ? `${withDelegationInstruction}\n\n${memoryContext}` : withDelegationInstruction;

  function toolContextFor(callId: string): ToolContext | undefined {
    if (!runtime) return undefined;
    const stageWriteState = runtime.stageWriteState;
    const stageDeleteState = runtime.stageDeleteState;
    const stageRememberMemory = runtime.stageRememberMemory;
    const stageForgetMemory = runtime.stageForgetMemory;
    return {
      personaId: runtime.personaId,
      jobId: runtime.jobId,
      toolCallId: callId,
      db: runtime.db,
      signal: runtime.signal,
      writeState: stageWriteState ? (key, content) => stageWriteState(callId, key, content) : undefined,
      deleteState: stageDeleteState ? (key) => stageDeleteState(callId, key) : undefined,
      rememberMemory: stageRememberMemory ? (entry) => stageRememberMemory(callId, entry) : undefined,
      forgetMemory: stageForgetMemory ? (label) => stageForgetMemory(callId, label) : undefined,
    };
  }

  async function generateWithTelemetry(
    system: string,
    messages: ModelMessage[],
    maxTokens?: number,
    includeTools = true,
  ): Promise<Awaited<ReturnType<typeof generateText>>> {
    await runtime?.assertLease?.();
    const model = resolveModel(persona.modelProvider, persona.modelName);
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model,
        system,
        messages,
        tools: includeTools ? registry.aiSdkToolsFor(toolIds) : undefined,
        abortSignal: runtime?.signal,
        maxOutputTokens: maxTokens,
      });
    } catch (err) {
      await onModelCall?.({
        provider: persona.modelProvider,
        model: persona.modelName,
        latencyMs: Date.now() - startedAt,
        finishReason: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await onModelCall?.({
      provider: persona.modelProvider,
      model: persona.modelName,
      latencyMs: Date.now() - startedAt,
      finishReason: result.finishReason ?? null,
      promptTokens: result.usage?.inputTokens ?? null,
      completionTokens: result.usage?.outputTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      error: null,
    });
    return result;
  }

  // Cache keyed by message-array length: applyThreadHygiene runs once per
  // tool round-trip within a turn, and state.messages only ever grows, so a
  // length that already produced an under-threshold estimate can't have
  // become over-threshold without also growing — re-serializing the whole
  // (ever-growing) transcript on every one of those round-trips is
  // otherwise redundant work for the rest of the job's life once the
  // threshold has been crossed once. This narrowly short-circuits that
  // specific redundant recompute without changing what triggers a pass —
  // the full-array threshold check below still runs whenever the length
  // actually changed, so summarization cadence is unaffected.
  let lastUncrossedLength = -1;

  async function applyThreadHygiene(state: PersonaState): Promise<Partial<PersonaState>> {
    if (!threadHygiene) return {};
    if (state.messages.length === lastUncrossedLength) return {};

    const totalTokens = estimateThreadTokens(state.messages);
    if (totalTokens <= THREAD_TOKEN_THRESHOLD) {
      lastUncrossedLength = state.messages.length;
      return {};
    }

    const current = selectThreadSummary(state, threadHygiene.initialSummary);
    const previousCount = current.summarizedMessageCount;
    let summary = current.summary;
    const contextStart = recentContextStart(state.messages);
    if (contextStart <= previousCount) {
      return { threadSummary: summary, summarizedMessageCount: previousCount };
    }

    const newlyOld = state.messages.slice(previousCount, contextStart);
    try {
      for (const chunk of summaryChunks(newlyOld)) {
        const result = await generateWithTelemetry(
          threadSummarySystemPrompt(summary),
          [{ role: "user", content: chunk }],
          1_000,
          false,
        );
        const chunkSummary = boundedSummary(result.text);
        if (!chunkSummary) {
          throw new Error("thread hygiene produced an empty thread summary; old turns were not compacted");
        }
        summary = chunkSummary;
      }
    } catch (err) {
      // Thread hygiene is a best-effort context-bounding pass, not part of the
      // turn's correctness — and by the time this node runs (after `tools`),
      // real tool side effects may already be durably committed. Failing the
      // node here would fail the whole job even though the assistant's work
      // already happened and can't be undone. Fail safe instead: skip
      // summarization for this pass, leave the prior context un-summarized,
      // and let the turn continue; a later pass can retry.
      console.warn(
        `applyThreadHygiene: summarization failed for job ${runtime?.jobId ?? "unknown"} — skipping this pass ` +
          "and keeping prior context unsummarized.",
        err,
      );
      return { threadSummary: current.summary, summarizedMessageCount: previousCount };
    }
    const next = { summary, summarizedMessageCount: contextStart };
    await runtime?.assertLease?.();
    await threadHygiene.save(next);
    return { threadSummary: summary, summarizedMessageCount: contextStart };
  }

  async function callModel(state: PersonaState): Promise<Partial<PersonaState>> {
    const current = selectThreadSummary(state, threadHygiene?.initialSummary);
    const conversationSummary = current.summary;
    const summarizedMessageCount = current.summarizedMessageCount;
    const modelSystemPrompt = conversationSummary
      ? `${systemPrompt}\n\n${threadContextSystemPrompt(conversationSummary)}`
      : systemPrompt;
    const result = await generateWithTelemetry(
      modelSystemPrompt,
      toModelMessages(state.messages.slice(summarizedMessageCount)),
    );
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: result.text || null,
      // SAFETY: `tc.input` is the AI SDK's already-parsed JSON object for this
      // call (checked against the tool's own JSON Schema when the model
      // produced it); the exact shape is per-tool and genuinely unknown here,
      // same as ToolSpec.run's own `args` parameter.
      toolCalls:
        result.toolCalls.length > 0
          ? result.toolCalls.map((tc) => ({
              id: tc.toolCallId,
              name: tc.toolName,
              arguments: tc.input as Record<string, unknown>,
            }))
          : undefined,
    };
    return { messages: [assistantMessage] };
  }

  async function callTools(state: PersonaState): Promise<Partial<PersonaState>> {
    const last = state.messages[state.messages.length - 1];
    const calls = last.toolCalls ?? [];

    // Phase 1 — resolve every gated call's approval decision, with zero side
    // effects. LangGraph replays this whole function from the top on every
    // resume; interrupt() is the only call memoized by position, so this
    // phase must not do anything else that a replay would repeat for real.
    // Each interrupt() either returns its memoized decision instantly
    // (already resolved by a prior resume) or pauses execution right here
    // (new/still-unresolved) — pausing ends the node call for this turn,
    // same as before. Only once every gated call's decision is known does
    // Phase 1 finish without pausing. "Gated" is a (tool, persona) decision
    // "Gated" is a (tool, persona) decision now: Allow runs, Ask pauses,
    // Blocked is refused in Phase 2 — see tools/autonomy.ts.
    const inFlightGated = new Set(runtime?.inFlightGatedToolIds ?? []);
    function gatedThisTurn(spec: ToolSpec): boolean {
      // An origin-blocked tool never runs (Phase 2 refuses it outright), so
      // it must never pause here for approval either — same reasoning as
      // permission-Blocked tools, which effectivePermission already keeps
      // out of isGated.
      if (!originAllowsTool(spec, jobOrigin)) return false;
      return isGated(spec, configFor(persona.assignedToolIds, spec.id)) || inFlightGated.has(spec.id);
    }

    const decisions = new Map<string, { approved: boolean }>();
    for (const call of calls) {
      // A revoked/deleted MCP tool (registry.unregister/unregisterNamespace,
      // called any time from mcp-routes.ts, including while this exact job
      // is paused waiting_approval on this exact call) must not crash this
      // whole node on resume/replay — tryResolveModelTool returns undefined
      // instead of throwing so that case degrades into a normal "tool no
      // longer available" tool-result in Phase 2 below, the same way any
      // other tool failure surfaces to the model, rather than propagating
      // past runAndReport's error boundary and failing the entire job.
      const spec = registry.tryResolveModelTool(call.name);
      if (spec && gatedThisTurn(spec)) {
        const args = registry.executionArgumentsFor(spec, call.arguments);
        // SAFETY: the only place this graph is ever resumed from is
        // dispatcher.ts's executeClaimedExecution, which always resumes with
        // exactly `{ approved: boolean }` (new Command({ resume: { approved } })).
        const decision = interrupt({ toolCallId: call.id, toolId: spec.id, arguments: args }) as {
          approved: boolean;
        };
        decisions.set(call.id, decision);
      }
    }

    // Phase 2 — real execution, exactly once. Reached only on the resume
    // where Phase 1 finished without pausing, i.e. every gated call in this
    // batch now has a known decision. Nothing here can run twice: this whole
    // node only ever gets this far on the one turn where the batch is fully
    // resolved.
    // Contains a thrown spec.run() so one failing tool becomes a tool result
    // the model can react to ("this failed, try something else") rather than
    // crashing the whole turn — and so onToolExecuted always fires with a
    // real success/failure outcome instead of the call never completing.
    async function runAndReport(
      spec: ToolSpec,
      args: Record<string, unknown>,
      gated: boolean,
      callId: string,
    ): Promise<Record<string, unknown>> {
      let output: Record<string, unknown>;
      let success = true;
      let externalEffectCompleted = false;
      try {
        // This check prevents knowingly stale work from beginning an external
        // effect. A lease can still expire while spec.run is in flight; tools
        // that support provider idempotency keys remain the only way to close
        // that unavoidable distributed-systems uncertainty window.
        await runtime?.assertLease?.();
        if (spec.externalSideEffect) await runtime?.beginExternalEffect?.(callId);
        output = await spec.run(args, toolContextFor(callId));
        externalEffectCompleted = Boolean(spec.externalSideEffect);
      } catch (err) {
        success = false;
        externalEffectCompleted =
          Boolean(spec.externalSideEffect) &&
          err instanceof Error &&
          "externalOutcomeKnown" in err &&
          err.externalOutcomeKnown === true;
        // `output`'s real type is whatever `spec.run` produces for an
        // arbitrary tool (genuinely unknown per-tool, hence
        // Record<string, unknown> above) -- this fallback just needs to fit
        // that same broad contract, not a narrower one of its own.
        const detail = boundedToolErrorDetail(err);
        // oxlint-disable-next-line anti-slop/no-known-value-widening -- output intentionally rejoins ToolSpec.run's open result contract.
        output = detail
          ? { error: err instanceof Error ? err.message : String(err), detail }
          : { error: err instanceof Error ? err.message : String(err) };
      }
      await onToolExecuted?.({
        callId,
        toolId: spec.id,
        riskClass: spec.riskClass,
        arguments: args,
        result: output,
        success,
        gated,
        externalEffectCompleted,
      });
      return output;
    }

    const results: ChatMessage[] = [];
    for (const call of calls) {
      await runtime?.assertLease?.();
      const spec = registry.tryResolveModelTool(call.name);
      let output: Record<string, unknown>;
      if (!spec) {
        // Same tool-no-longer-resolves case as Phase 1 above: surface a
        // normal tool-error result the model can react to instead of
        // throwing past runAndReport's error boundary and failing the job.
        // oxlint-disable-next-line anti-slop/no-known-value-widening -- output intentionally rejoins ToolSpec.run's open result contract.
        output = { error: "tool no longer available" };
      } else if (!originAllowsTool(spec, jobOrigin)) {
        // Same never-execute-never-prompt treatment as permission-Blocked
        // below, for a different reason: this job's origin (cron/delegation/
        // webhook) isn't one this tool allows, regardless of the persona's
        // assigned permission. Checked before the permission branch so an
        // Ask-gated, origin-restricted tool degrades here rather than
        // falling through to a permission decision that no longer applies.
        // oxlint-disable-next-line anti-slop/no-known-value-widening -- output intentionally rejoins ToolSpec.run's open result contract.
        output = { error: "tool requires a different job origin" };
      } else if (effectivePermission(spec, configFor(persona.assignedToolIds, spec.id)) === "blocked") {
        // Unassigned tools are Blocked: never execute, never prompt. The
        // model shouldn't see these (aiSdkToolsFor only gets assigned ids),
        // but a hallucinated name still has to degrade into a tool error
        // rather than running as if it were Allow.
        // oxlint-disable-next-line anti-slop/no-known-value-widening -- output intentionally rejoins ToolSpec.run's open result contract.
        output = { error: "tool is blocked for this persona" };
      } else if (spec.id === "delegate_to" && onDelegate) {
        const args = registry.executionArgumentsFor(spec, call.arguments);
        try {
          // SAFETY: the AI SDK validates tool-call arguments against
          // delegate_to's own `parameters` JSON Schema (personaId/task:
          // string, both required) before this branch ever runs.
          output = await onDelegate(args.personaId as string, args.task as string);
        } catch (err) {
          // `output` intentionally rejoins OnDelegate's open tool-result contract so the model receives the failure.
          // oxlint-disable-next-line anti-slop/no-known-value-widening
          output = {
            delegated: false,
            reason: `delegate errored: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else if (gatedThisTurn(spec)) {
        const args = registry.executionArgumentsFor(spec, call.arguments);
        const decision = decisions.get(call.id)!;
        output = decision.approved ? await runAndReport(spec, args, true, call.id) : { error: "rejected by user" };
      } else {
        output = await runAndReport(spec, registry.executionArgumentsFor(spec, call.arguments), false, call.id);
      }
      // toolName must match the alias the assistant's tool-call message used
      // (call.name — see callModel's `name: tc.toolName` above), not the
      // canonical registry id: the AI SDK/provider correlates a tool result
      // to its call by toolCallId *and* expects the same toolName on both
      // messages, and every MCP tool id gets a distinct provider-facing
      // alias from registry.ts's allocateModelName.
      results.push({ role: "tool", content: JSON.stringify(output), toolCallId: call.id, toolName: call.name });
    }
    return { messages: results };
  }

  const graph = new StateGraph(PersonaStateAnnotation)
    .addNode("thread_hygiene", applyThreadHygiene)
    .addNode("model", callModel)
    .addNode("tools", callTools)
    .addEdge(START, "thread_hygiene")
    .addEdge("thread_hygiene", "model")
    .addConditionalEdges("model", routeAfterModel, { tools: "tools", [END]: END })
    .addEdge("tools", "thread_hygiene");

  return graph.compile({ checkpointer: checkpointer ?? new MemorySaver() });
}
