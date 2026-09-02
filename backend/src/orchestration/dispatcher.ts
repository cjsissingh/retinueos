// backend/src/orchestration/dispatcher.ts
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { personas, type JobRow, type PersonaRow } from "../db/schema.js";
import { buildPersonaGraph, type OnModelCall } from "../graph/persona-graph.js";
import type { PersonaState } from "../graph/state.js";
import type { ToolRegistry } from "../tools/registry.js";
import { claimQueuedJob, createJob, getJob, transitionJobStatus } from "../jobs/job-repo.js";
import { createMessage, getLastAssistantMessage, listMessagesByJob } from "../jobs/message-repo.js";
import { recordModelCall } from "../models/model-call-repo.js";
import type {
  AppliedAttemptEffects,
  AttemptOutcome,
  ClaimedExecution,
  CompletionEffect,
  DelegatedChildInput,
  InFlightAttemptEffect,
  WaitingApprovalEffect,
} from "../jobs/job-attempt-repo.js";
import { getPersona, resolvePersonaReference } from "../personas/persona-repo.js";
import { createToolCall, completeToolCallByCallId, listToolCallsByJob } from "../tool-calls/tool-call-repo.js";
import { updateRoutineFired } from "../personas/routine-repo.js";
import { notify } from "../notifications/notify.js";
import { writeState, deleteState } from "../personas/persona-state-repo.js";
import { forgetMemoryByLabel, rememberMemory } from "../personas/persona-memory-repo.js";
import { checkDelegationAllowed } from "./delegation.js";
import { JobEventBus, defaultJobEventBus } from "./event-bus.js";
import { broadcastPendingApprovals } from "./pending-approval-bus.js";
import { buildMemoryContext } from "../graph/memory-context.js";
import { loadJobSummary, saveJobSummary } from "../personas/job-summary-memory.js";

interface InterruptValue {
  toolCallId: string;
  toolId: string;
  arguments: Record<string, unknown>;
}

interface InterruptChunk {
  __interrupt__: Array<{ value: InterruptValue }>;
}

export type AssertLiveLease = () => Promise<void>;
export type ExecuteDelegatedChild = (input: DelegatedChildInput) => Promise<JobRow>;
export type ApplyAttemptEffects = (effects: readonly InFlightAttemptEffect[]) => Promise<AppliedAttemptEffects>;
export type BeginExternalEffect = (callId: string) => Promise<void>;

type UserMessageGraphInput = { messages: [{ role: "user"; content: string }] };

interface CheckpointChannelValues {
  messages?: Array<{ role?: string }>;
}

// `channelValues` is LangGraph's untyped checkpoint bag — the checkpointer
// types it as a dictionary, and this guard is the parser at that boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function checkpointUserMessageCount(channelValues: unknown): number {
  if (typeof channelValues !== "object" || channelValues === null || !("messages" in channelValues)) return 0;
  // SAFETY: `messages` is only walked after Array.isArray confirms it; each
  // element's `role` is read only after that element is a non-null object.
  const messages = (channelValues as CheckpointChannelValues).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (typeof message === "object" && message !== null && message.role === "user") count += 1;
  }
  return count;
}

async function countCheckpointUserMessages(
  checkpointer: BaseCheckpointSaver | undefined,
  threadId: string,
): Promise<number> {
  if (!checkpointer) return 0;
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  return checkpointUserMessageCount(tuple?.checkpoint.channel_values);
}

/**
 * Retry uses empty graph input only when LangGraph already has the human
 * turn. The transcript row is written at enqueue, but the checkpointer only
 * records that message once the first superstep lands — cancel-while-queued
 * (or any failure before streamEvents) leaves the thread without it, and
 * `{}` would either answer with no prompt or re-answer the previous turn.
 */
async function graphInputForRetry(
  db: DrizzleDb,
  job: Pick<JobRow, "id" | "langgraphThreadId">,
  checkpointer: BaseCheckpointSaver | undefined,
): Promise<UserMessageGraphInput | Record<string, never>> {
  const transcriptUserMessages = (await listMessagesByJob(db, job.id)).filter((message) => message.role === "user");
  const latest = transcriptUserMessages.at(-1);
  if (!latest) return {};
  const checkpointedUserCount = await countCheckpointUserMessages(checkpointer, job.langgraphThreadId);
  if (checkpointedUserCount >= transcriptUserMessages.length) return {};
  return { messages: [{ role: "user", content: latest.content }] };
}

async function applyLegacyInFlightEffects(
  db: DrizzleDb,
  job: JobRow,
  effects: readonly InFlightAttemptEffect[],
): Promise<AppliedAttemptEffects> {
  const applied: AppliedAttemptEffects = { toolCalls: [], personaState: [], notifications: [] };
  for (const effect of effects) {
    switch (effect.type) {
      case "write_persona_state":
        applied.personaState.push(await writeState(db, job.personaId, effect.key, effect.content));
        break;
      case "delete_persona_state":
        await deleteState(db, job.personaId, effect.key);
        break;
      case "remember_persona_memory":
        await rememberMemory(db, {
          id: effect.id,
          personaId: effect.personaId,
          label: effect.label,
          content: effect.content,
          sourceJobId: effect.sourceJobId,
          sensitivity: effect.sensitivity,
          importance: effect.importance,
        });
        break;
      case "forget_persona_memory":
        await forgetMemoryByLabel(db, effect.personaId, effect.label);
        break;
      case "record_tool_result": {
        const row = effect.gated
          ? await completeToolCallByCallId(db, job.id, effect.callId, effect.status, effect.result)
          : await createToolCall(db, {
              jobId: job.id,
              callId: effect.callId,
              toolId: effect.toolId,
              riskClass: effect.riskClass,
              arguments: effect.arguments,
              status: effect.status,
              result: effect.result,
            });
        if (row) applied.toolCalls.push(row);
        break;
      }
    }
  }
  return applied;
}

async function applyLegacyTerminalEffects(db: DrizzleDb, job: JobRow, persona: PersonaRow, outcome: AttemptOutcome) {
  if (outcome.status === "failed") return;
  for (const effect of outcome.effects ?? []) {
    switch (effect.type) {
      case "create_pending_tool_call":
        await createToolCall(db, {
          jobId: job.id,
          callId: effect.callId,
          toolId: effect.toolId,
          riskClass: effect.riskClass,
          arguments: effect.arguments,
        });
        break;
      case "append_assistant_message":
        await createMessage(db, job.id, "assistant", effect.content, effect.at);
        break;
      case "set_persona_summary":
        await db.update(personas).set({ lastSummary: effect.content }).where(eq(personas.id, persona.id));
        break;
      case "set_routine_summary":
        if (job.routineId === effect.routineId) await updateRoutineFired(db, effect.routineId, effect.content);
        break;
      case "insert_notification":
        if (effect.routineId !== undefined && job.routineId !== effect.routineId) break;
        await notify(db, {
          message: effect.message,
          urgent: effect.urgent,
          personaId: persona.id,
          jobId: job.id,
        });
        break;
    }
  }
}

export function publishCommittedOutcomeEvents(bus: JobEventBus, jobId: string, outcome: AttemptOutcome): void {
  if (outcome.status === "failed") return;
  for (const event of outcome.events ?? []) bus.publish(jobId, event);
  if (outcome.status === "waiting_approval") {
    for (const effect of outcome.effects ?? []) {
      if (effect.type === "create_pending_tool_call") {
        bus.publish(jobId, { type: "tool_call", toolId: effect.toolId, arguments: effect.arguments });
      }
    }
  }
}

// `chunk` is exactly what this guard exists to parse -- LangGraph's stream
// yields whichever chunk shape the current node produces, so there is no
// narrower type to declare here without lying about it.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isInterruptChunk(chunk: unknown): chunk is InterruptChunk {
  // SAFETY: this cast only reads `__interrupt__`, whose presence the `in`
  // check just confirmed; the guard isn't satisfied (returns false) unless
  // that property is also an array, so the cast never leaks past a shape
  // this function hasn't actually verified.
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    "__interrupt__" in chunk &&
    Array.isArray((chunk as InterruptChunk).__interrupt__)
  );
}

/**
 * A guarded transition returning no row means another caller changed the
 * job first. Never pretend that caller's current row is the result of our
 * transition: doing so lets two executors believe they own the same job.
 */
async function requireTransitionedJob(
  db: DrizzleDb,
  id: string,
  expectedStatus: JobRow["status"],
  status: JobRow["status"],
): Promise<JobRow> {
  const updated = await transitionJobStatus(db, id, expectedStatus, status);
  if (updated) return updated;
  const existing = await getJob(db, id);
  throw new Error(
    existing
      ? `job ${id} cannot transition from "${expectedStatus}" to "${status}" because it is "${existing.status}"`
      : `job ${id} disappeared while transitioning from "${expectedStatus}" to "${status}"`,
  );
}

async function failClaimedJob(db: DrizzleDb, jobId: string, message: string, bus: JobEventBus): Promise<void> {
  const failed = await transitionJobStatus(db, jobId, "running", "failed", message);
  if (failed) bus.publish(jobId, { type: "status", status: "failed" });
}

/**
 * Turns a delegated child's settled JobRow into the tool result
 * delegate_to's caller (onDelegate, above) actually returns to the model —
 * the child's real last reply when it finished, a clear "still working"
 * note when it paused on its own approval gate, or a clear failure reason
 * otherwise. Never a placeholder: DELEGATION_FOLD_INSTRUCTION
 * (graph/charter.ts) is only honest if what it's folding is real.
 */
async function foldDelegateResult(db: DrizzleDb, completed: JobRow) {
  if (completed.status === "waiting_approval") {
    return {
      delegated: true,
      childJobId: completed.id,
      note: "delegate is waiting on its own approval and has not reported back yet",
    };
  }
  if (completed.status !== "done") {
    return {
      delegated: false,
      childJobId: completed.id,
      reason: completed.error ?? `delegate job ended in unexpected status "${completed.status}"`,
    };
  }
  const lastMessage = await getLastAssistantMessage(db, completed.id);
  return {
    delegated: true,
    childJobId: completed.id,
    result: lastMessage?.content ?? "(delegate produced no reply)",
  };
}

/**
 * Drives one graph turn (a fresh user message, or a resume Command) to
 * completion or to the next interrupt, then settles the job row.
 *
 * Shared by runJob and executeClaimedExecution so both go through identical
 * interrupt detection and delegation-execution logic — a resume is not just
 * "replay to done": it can pause again (e.g. a second gated tool call later
 * in the same turn) and can itself trigger delegations.
 *
 * Delegation and replay safety: see the Phase 1 / Phase 2 comments on
 * `callTools` in persona-graph.ts for how a single model turn that mixes a
 * delegate_to call with a gated tool call is kept idempotent across
 * LangGraph's replay-from-top resume semantics. `onDelegate` below runs
 * synchronously inside that same Phase 2, so a rejected delegation (depth or
 * descendant limit) is decided before the model ever sees a result for it.
 */
type PersonaGraphNode = "__start__" | "model" | "tools" | "thread_hygiene";
type PersonaGraphCommand = Command<{ approved: boolean }, Partial<PersonaState>, PersonaGraphNode>;
type PersonaGraphInput =
  { messages: [{ role: "user"; content: string }] } | Record<string, never> | PersonaGraphCommand;

async function driveTurn(
  db: DrizzleDb,
  job: JobRow,
  persona: PersonaRow,
  registry: ToolRegistry,
  checkpointer: BaseCheckpointSaver | undefined,
  bus: JobEventBus,
  input: PersonaGraphInput,
  assertLive: AssertLiveLease,
  applyAttemptEffects: ApplyAttemptEffects,
  executeDelegatedChild?: ExecuteDelegatedChild,
  signal?: AbortSignal,
  beginExternalEffect?: BeginExternalEffect,
): Promise<AttemptOutcome> {
  const stagedToolEffects = new Map<string, InFlightAttemptEffect[]>();
  const committedEvents: Array<{ type: "model_end"; content: string | null }> = [];
  const onDelegate = async (targetPersonaReference: string, task: string) => {
    await assertLive();
    // Runs synchronously inside the graph's "tools" node (Phase 2 of
    // callTools in persona-graph.ts), before the model's next turn is
    // generated from this result. Checking the delegation limit here — not
    // afterward — means a rejection becomes part of the tool result the
    // model actually sees, so it can react (answer directly, escalate)
    // instead of being told delegation succeeded when no child job exists.
    const { allowed, reason } = await checkDelegationAllowed(db, job);
    if (!allowed) return { delegated: false, reason };
    // The model picks `personaId` freely from its own prompt and is commonly
    // given a person's name rather than an opaque database UUID. Resolve a
    // UUID, exact name, or derived slug against the roster before touching a
    // UUID column. Without this check a hallucinated or since-deleted target would produce a child job
    // stuck forever with nothing driving it: never executed, never marked
    // failed, invisible to both the model (which was already told
    // `delegated: true`) and the user. Reject it here instead, the same way
    // a depth/descendant rejection is surfaced, so no orphan job is ever
    // created.
    const target = await resolvePersonaReference(db, targetPersonaReference);
    if (!target) return { delegated: false, reason: `no persona uniquely matches "${targetPersonaReference}"` };

    // The child runs to completion — or to its own approval gate — right
    // here, inline, before this function returns. That's what makes the
    // fold real: callTools's "tools" -> "model" edge loops straight back
    // into another model call in *this same turn*, and that call sees the
    // delegate's genuine last reply as this tool call's result (via
    // foldDelegateResult below), giving DELEGATION_FOLD_INSTRUCTION
    // (charter.ts) something true to work with — not a "will be created
    // later" placeholder the model can say nothing truthful about. The
    // trade-off is that delegations are sequential: a turn with two
    // delegate_to calls runs them one after another, not in parallel (see
    // the architecture review's "parallel fan-out" gap).
    let childJobId: string | undefined;
    try {
      let completed: JobRow;
      if (executeDelegatedChild) {
        const langgraphThreadId = randomUUID();
        // The child's own id isn't known until executeDelegatedChild
        // resolves (it creates the row), so there's no "start" event with a
        // real childJobId to publish beforehand — delegation_end below is
        // the one durable signal, published once the child's real outcome
        // is known.
        completed = await executeDelegatedChild({ personaId: target.id, prompt: task, langgraphThreadId });
      } else {
        // Compatibility path for direct dispatcher tests (no durable
        // worker/attempt system in play) — runs the child the same way
        // runJob always has, just outside the lease/attempt machinery.
        const child = await createJob(db, {
          personaId: target.id,
          parentJobId: job.id,
          depth: job.depth + 1,
          origin: "delegation",
          prompt: task,
        });
        childJobId = child.id;
        bus.publish(job.id, { type: "delegation_start", childJobId: child.id, targetPersonaId: target.id, task });
        completed = await runJob(db, child, target, registry, checkpointer, task, bus);
      }
      childJobId = completed.id;
      bus.publish(job.id, { type: "delegation_end", childJobId: completed.id, status: completed.status });
      return await foldDelegateResult(db, completed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (childJobId) bus.publish(job.id, { type: "delegation_end", childJobId, status: "failed" });
      return { delegated: false, childJobId, reason: `delegate errored: ${message}` };
    }
  };

  // Completes the tool_calls audit lifecycle (05-job-creation-and-audit-ui.md):
  // a gated call already has a `pending_approval` row from the interrupt
  // below (this same turn or an earlier one) — find it by (jobId, callId)
  // and write its real outcome. A non-gated call never paused, so there is
  // no existing row; insert one directly, already resolved. Either way the
  // frontend's SSE "tool_result" event — declared in event-bus.ts but never
  // published before this — lets the Approvals/audit UI show what actually
  // happened instead of assuming success the moment a click fires.
  const onToolExecuted = async (info: {
    callId: string;
    toolId: string;
    riskClass: "read_only" | "reversible" | "destructive";
    arguments: Record<string, unknown>;
    result: Record<string, unknown>;
    success: boolean;
    gated: boolean;
    externalEffectCompleted: boolean;
  }) => {
    const status = info.success ? ("executed" as const) : ("failed" as const);
    const effects = stagedToolEffects.get(info.callId) ?? [];
    await applyAttemptEffects([
      ...effects,
      {
        type: "record_tool_result",
        callId: info.callId,
        toolId: info.toolId,
        riskClass: info.riskClass,
        arguments: info.arguments,
        status,
        result: info.result,
        gated: info.gated,
        externalEffectCompleted: info.externalEffectCompleted,
      },
    ]);
    stagedToolEffects.delete(info.callId);
    bus.publish(job.id, { type: "tool_result", toolId: info.toolId, result: info.result });
  };

  // Written the moment the call returns, success or failure -- not fenced
  // behind attempt settlement like tool effects are (see
  // db/schema.ts's modelCalls doc comment for why: the provider was already
  // called regardless of what this attempt's outcome later turns out to be).
  const onModelCall: OnModelCall = async (info) => {
    await recordModelCall(db, {
      jobId: job.id,
      personaId: persona.id,
      provider: info.provider,
      model: info.model,
      finishReason: info.finishReason,
      promptTokens: info.promptTokens,
      completionTokens: info.completionTokens,
      totalTokens: info.totalTokens,
      latencyMs: info.latencyMs,
      error: info.error,
    });
  };

  const [memoryContext, initialThreadSummary, inFlightToolCalls] = await Promise.all([
    buildMemoryContext(db, persona.id),
    loadJobSummary(db, persona.id, job.id),
    listToolCallsByJob(db, job.id),
  ]);
  const inFlightGatedToolIds = inFlightToolCalls
    .filter((tc) => tc.status === "pending_approval" || tc.status === "approved")
    .map((tc) => tc.toolId);
  const graph = buildPersonaGraph(
    persona,
    registry,
    checkpointer,
    onDelegate,
    {
      db,
      personaId: persona.id,
      jobId: job.id,
      origin: job.origin,
      assertLease: assertLive,
      signal,
      beginExternalEffect,
      inFlightGatedToolIds,
      stageWriteState: async (callId, key, content) => {
        const effects = stagedToolEffects.get(callId) ?? [];
        effects.push({ type: "write_persona_state", key, content });
        stagedToolEffects.set(callId, effects);
      },
      stageDeleteState: async (callId, key) => {
        const effects = stagedToolEffects.get(callId) ?? [];
        effects.push({ type: "delete_persona_state", key });
        stagedToolEffects.set(callId, effects);
      },
      stageRememberMemory: async (callId, entry) => {
        const effects = stagedToolEffects.get(callId) ?? [];
        effects.push({ type: "remember_persona_memory", ...entry });
        stagedToolEffects.set(callId, effects);
      },
      stageForgetMemory: async (callId, label) => {
        const effects = stagedToolEffects.get(callId) ?? [];
        effects.push({ type: "forget_persona_memory", personaId: job.personaId, label });
        stagedToolEffects.set(callId, effects);
      },
    },
    onToolExecuted,
    onModelCall,
    memoryContext,
    {
      initialSummary: initialThreadSummary,
      save: async (summary) => {
        await assertLive();
        await saveJobSummary(db, persona.id, job.id, summary);
      },
    },
  );
  const config = { configurable: { thread_id: job.langgraphThreadId }, version: "v2" as const };

  let pendingInterrupt: InterruptValue | undefined;
  let lastAssistantContent: string | null = null;

  await assertLive();
  const stream = await graph.streamEvents(input, config);
  for await (const event of stream) {
    // Node-level completion events (e.g. the "model" node) carry the node's
    // returned partial state directly as `output` — not nested further.
    if (event.event === "on_chain_end" && event.name === "model") {
      // SAFETY: verified against the installed @langchain/langgraph runtime
      // (see comment above) -- `on_chain_end` for the "model" node carries
      // that node's returned partial PersonaState as `event.data.output`.
      const output = (event.data as { output?: { messages?: Array<{ content?: string | null }> } } | undefined)?.output;
      const lastMessage = output?.messages?.[output.messages.length - 1];
      if (lastMessage) {
        lastAssistantContent = lastMessage.content ?? null;
        committedEvents.push({ type: "model_end", content: lastMessage.content ?? null });
      }
    }

    // A gated tool call triggers `interrupt()` inside the "tools" node, which
    // throws and is suppressed by the graph loop rather than surfacing as a normal
    // node completion or an error event. The only place it's observable — with or
    // without a checkpointer configured — is the graph-level "on_chain_stream"
    // chunk carrying a `__interrupt__` key (verified against the installed
    // @langchain/langgraph runtime; `graph.getState()` requires a checkpointer and
    // throws "No checkpointer set" otherwise, so it can't be relied on here).
    if (event.event === "on_chain_stream") {
      // SAFETY: verified against the installed @langchain/langgraph runtime
      // (see comment above) -- an "on_chain_stream" event's `event.data`
      // always carries the streamed value under `.chunk`.
      const chunk = (event.data as { chunk?: unknown } | undefined)?.chunk;
      if (isInterruptChunk(chunk) && chunk.__interrupt__.length > 0) {
        pendingInterrupt = chunk.__interrupt__[0]!.value;
      }
    }
  }

  await assertLive();

  if (pendingInterrupt) {
    if (!checkpointer) {
      console.warn(
        `runJob: job ${job.id} paused on interrupt for tool "${pendingInterrupt.toolId}" without a ` +
          "checkpointer configured — no pregel state was saved, so this job cannot actually be resumed.",
      );
    }
    const tool = registry.get(pendingInterrupt.toolId);
    const effects: WaitingApprovalEffect[] = [
      {
        type: "create_pending_tool_call",
        callId: pendingInterrupt.toolCallId,
        toolId: pendingInterrupt.toolId,
        riskClass: tool.riskClass,
        arguments: pendingInterrupt.arguments,
      },
    ];
    if (lastAssistantContent) {
      effects.push({ type: "append_assistant_message", content: lastAssistantContent, at: new Date() });
    }
    return { status: "waiting_approval", effects, events: committedEvents };
  }

  await assertLive();
  const effects: CompletionEffect[] = [];
  if (lastAssistantContent) {
    effects.push(
      { type: "set_persona_summary", content: lastAssistantContent },
      { type: "append_assistant_message", content: lastAssistantContent, at: new Date() },
    );
  }

  // Routine lastSummary bookkeeping only. Outcome push is created in
  // settleAttempt from the attempt's notifyOnOutcome flag (copied from
  // routines.notifyRoutineRan at enqueue). A success-only insert_notification
  // here made settlement skip that fallback, so failed routine runs stayed
  // silent. Always-notify behavior for waiting approvals should stack on
  // the settlement hook, not this completion path.
  if (job.routineId && lastAssistantContent) {
    effects.push({ type: "set_routine_summary", routineId: job.routineId, content: lastAssistantContent });
  }

  return { status: "done", effects, events: committedEvents };
}

/**
 * Executes an already-claimed durable attempt. The worker owns settlement.
 * Lease assertions prevent knowingly stale external work; applyAttemptEffects
 * transactionally fences attempt-owned writes. LangGraph's independently
 * managed checkpoint tables remain outside this fence.
 */
export async function executeClaimedExecution(
  db: DrizzleDb,
  execution: ClaimedExecution,
  registry: ToolRegistry,
  checkpointer: BaseCheckpointSaver | undefined,
  bus: JobEventBus,
  signal: AbortSignal,
  assertLive: AssertLiveLease,
  beginExternalEffect: BeginExternalEffect,
  applyAttemptEffects: ApplyAttemptEffects,
  executeDelegatedChild: ExecuteDelegatedChild,
): Promise<AttemptOutcome> {
  const persona = await getPersona(db, execution.job.personaId);
  if (!persona) throw new Error(`persona ${execution.job.personaId} no longer exists`);
  // Retry normally resumes with `{}` so a checkpointed human message is not
  // appended twice. graphInputForRetry re-supplies that message when the
  // previous attempt never reached the first superstep (see that helper).
  const input: PersonaGraphInput =
    execution.attempt.input.type === "user_message"
      ? { messages: [{ role: "user", content: execution.attempt.input.content }] }
      : execution.attempt.input.type === "retry"
        ? await graphInputForRetry(db, execution.job, checkpointer)
        : new Command<{ approved: boolean }, Partial<PersonaState>, PersonaGraphNode>({
            resume: { approved: execution.attempt.input.approved },
          });
  return driveTurn(
    db,
    execution.job,
    persona,
    registry,
    checkpointer,
    bus,
    input,
    assertLive,
    applyAttemptEffects,
    executeDelegatedChild,
    signal,
    beginExternalEffect,
  );
}

export async function runJob(
  db: DrizzleDb,
  job: JobRow,
  persona: PersonaRow,
  registry: ToolRegistry,
  checkpointer: BaseCheckpointSaver | undefined,
  userMessage: string,
  bus: JobEventBus = defaultJobEventBus,
): Promise<JobRow> {
  const claimed = await claimQueuedJob(db, job.id);
  if (!claimed) {
    const current = await getJob(db, job.id);
    throw new Error(`job ${job.id} cannot be claimed from "queued" because it is "${current?.status ?? "missing"}"`);
  }
  bus.publish(job.id, { type: "status", status: "running" });
  try {
    const outcome = await driveTurn(
      db,
      claimed,
      persona,
      registry,
      checkpointer,
      bus,
      { messages: [{ role: "user", content: userMessage }] },
      async () => {},
      (effects) => applyLegacyInFlightEffects(db, job, effects),
    );
    await applyLegacyTerminalEffects(db, job, persona, outcome);
    const updated = await requireTransitionedJob(db, job.id, "running", outcome.status);
    publishCommittedOutcomeEvents(bus, job.id, outcome);
    bus.publish(job.id, { type: "status", status: outcome.status });
    await broadcastPendingApprovals(db);
    return updated;
  } catch (error) {
    await failClaimedJob(db, job.id, error instanceof Error ? error.message : String(error), bus).catch(
      (settleError) => {
        console.error(`also failed to mark job ${job.id} failed:`, settleError);
      },
    );
    throw error;
  }
}
