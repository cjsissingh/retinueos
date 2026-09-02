import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import type { DrizzleDb } from "../src/db/client.js";
import { RoutineService } from "../src/control/routine-service.js";
import { buildPersonaGraph, type PersonaLike } from "../src/graph/persona-graph.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { defaultRegistry, ToolRegistry, type ToolSpec } from "../src/tools/registry.js";
import { makeCheckpointer } from "../src/graph/checkpointer.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

beforeEach(() => {
  // SAFETY: these graph-only tests never execute a routine adapter; the
  // service is retained only by those unused adapter closures while native
  // tool registration makes get_weather/delegate_to available to the graph.
  registerBuiltinTools(defaultRegistry, { routineService: new RoutineService({} as DrizzleDb) });
});

const fakePersona: PersonaLike = {
  modelProvider: "anthropic",
  modelName: "claude-sonnet-5",
  systemPrompt: "You are a helpful assistant.",
  assignedToolIds: [{ toolId: "get_weather" }],
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("buildPersonaGraph", () => {
  it("answers directly when the model returns no tool calls", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "It's sunny.", toolCalls: [] } as any);
    const graph = buildPersonaGraph(fakePersona, defaultRegistry);
    const result = await graph.invoke(
      { messages: [{ role: "user", content: "hi" }] },
      { configurable: { thread_id: "test-thread" } },
    );
    const final = result.messages[result.messages.length - 1];
    expect(final.content).toBe("It's sunny.");
  });

  it("leaves below-threshold context unchanged without summarizing or saving", async () => {
    const saved: Array<{ summary: string; summarizedMessageCount: number }> = [];
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Short answer.", toolCalls: [] } as any);
    const graph = buildPersonaGraph(
      fakePersona,
      defaultRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      {
        save: async (summary) => {
          saved.push(summary);
        },
      },
    );
    const inputMessages = [
      { role: "user" as const, content: "First short question." },
      { role: "assistant" as const, content: "First short answer." },
      { role: "user" as const, content: "Second short question." },
    ];

    await graph.invoke({ messages: inputMessages }, { configurable: { thread_id: randomUUID() } });

    expect(saved).toEqual([]);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText).mock.calls[0]![0].messages).toEqual(inputMessages);
    expect(vi.mocked(generateText).mock.calls[0]![0].system).not.toContain("Running conversation summary");
  });

  it("prefers a persisted summary over stale checkpoint summary state at the same boundary", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Current answer.", toolCalls: [] } as any);
    const graph = buildPersonaGraph(
      fakePersona,
      defaultRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      {
        initialSummary: {
          summary: "Persisted authoritative summary.",
          summarizedMessageCount: 2,
        },
        save: async () => {},
      },
    );

    await graph.invoke(
      {
        messages: [
          { role: "user", content: "OLD_RAW_CONTEXT" },
          { role: "assistant", content: "Old answer." },
          { role: "user", content: "Current question." },
        ],
        threadSummary: "Stale checkpoint summary.",
        summarizedMessageCount: 2,
      },
      { configurable: { thread_id: randomUUID() } },
    );

    const responseCall = vi.mocked(generateText).mock.calls[0]![0];
    expect(responseCall.system).toContain("Persisted authoritative summary.");
    expect(responseCall.system).not.toContain("Stale checkpoint summary.");
    expect(JSON.stringify(responseCall.messages)).toContain("Current question.");
    expect(JSON.stringify(responseCall.messages)).not.toContain("OLD_RAW_CONTEXT");
  });

  it.each([
    { name: "past the available messages", summarizedMessageCount: 99, summary: "Spoofed range summary." },
    { name: "between a user and assistant message", summarizedMessageCount: 1, summary: "Spoofed boundary summary." },
    { name: "with an oversized summary", summarizedMessageCount: 2, summary: "s".repeat(4_001) },
  ])("ignores a persisted summary $name and keeps raw context", async ({ summarizedMessageCount, summary }) => {
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Current answer.", toolCalls: [] } as any);
    const graph = buildPersonaGraph(
      fakePersona,
      defaultRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      {
        initialSummary: { summary, summarizedMessageCount },
        save: async () => {},
      },
    );

    await graph.invoke(
      {
        messages: [
          { role: "user", content: "OLD_USER_CONTEXT" },
          { role: "assistant", content: "OLD_ASSISTANT_CONTEXT" },
          { role: "user", content: "CURRENT_CONTEXT" },
        ],
      },
      { configurable: { thread_id: randomUUID() } },
    );

    const responseCall = vi.mocked(generateText).mock.calls[0]![0];
    const visible = JSON.stringify(responseCall.messages);
    expect(responseCall.system).not.toContain(summary);
    expect(visible).toContain("OLD_USER_CONTEXT");
    expect(visible).toContain("OLD_ASSISTANT_CONTEXT");
    expect(visible).toContain("CURRENT_CONTEXT");
  });

  it("summarizes old turns before the response model sees an over-threshold thread", async () => {
    const saved: Array<{ summary: string; summarizedMessageCount: number }> = [];
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Partial summary of the old project.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "The user introduced an old private project.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "Current answer.", toolCalls: [] } as any);

    const graph = buildPersonaGraph(
      fakePersona,
      defaultRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      {
        save: async (summary) => {
          saved.push(summary);
        },
      },
    );
    const result = await graph.invoke(
      {
        messages: [
          { role: "user", content: `OLD_PRIVATE_CONTEXT ${"x".repeat(32_000)}` },
          { role: "assistant", content: "Old reply." },
          { role: "user", content: `CURRENT_OVERSIZED ${"y".repeat(20_000)}` },
        ],
      },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(result.messages.at(-1)?.content).toBe("Current answer.");
    expect(saved).toEqual([{ summary: "The user introduced an old private project.", summarizedMessageCount: 2 }]);

    const summaryCalls = vi.mocked(generateText).mock.calls.slice(0, 2);
    expect(summaryCalls.every(([call]) => JSON.stringify(call.messages).length < 25_000)).toBe(true);
    expect(summaryCalls.every(([call]) => call.tools === undefined)).toBe(true);

    const responseCall = vi.mocked(generateText).mock.calls[2]![0];
    expect(JSON.stringify(responseCall.messages)).toContain("CURRENT_OVERSIZED");
    expect(JSON.stringify(responseCall.messages)).not.toContain("OLD_PRIVATE_CONTEXT");
    expect(responseCall.system).toContain("The user introduced an old private project.");
  });

  it("fails summarization safe: an empty running summary skips this pass instead of failing the job", async () => {
    // Regression test: this node runs after `tools`, once real tool side
    // effects may already be durably committed. A provider content-filter
    // refusal (or any other cause of an empty/whitespace summary) here must
    // never throw out of the turn — that would fail the whole job even
    // though the assistant's work already happened and can't be undone.
    const save = vi.fn(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Partial summary.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "   ", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "Current answer.", toolCalls: [] } as any);
    const graph = buildPersonaGraph(
      fakePersona,
      defaultRegistry,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      { save },
    );

    const result = await graph.invoke(
      {
        messages: [
          { role: "user", content: `OLD_CONTEXT ${"x".repeat(32_000)}` },
          { role: "assistant", content: "Old reply." },
          { role: "user", content: "Current question." },
        ],
      },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(result.messages.at(-1)?.content).toBe("Current answer.");
    // Summarization never completed a pass, so nothing gets persisted and
    // the un-summarized context is still what the model sees next turn.
    expect(save).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("executes a read-only tool call and loops back to the model", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "get_weather", input: { city: "Boston" } }],
      } as any)
      .mockResolvedValueOnce({ text: "It's 68 degrees.", toolCalls: [] } as any);
    const graph = buildPersonaGraph(fakePersona, defaultRegistry);
    const result = await graph.invoke(
      { messages: [{ role: "user", content: "weather in Boston?" }] },
      { configurable: { thread_id: "test-thread-2" } },
    );
    const final = result.messages[result.messages.length - 1];
    expect(final.content).toBe("It's 68 degrees.");
  });

  it("turns a thrown delegation into a tool result the model can handle", async () => {
    const persona: PersonaLike = { ...fakePersona, assignedToolIds: [{ toolId: "delegate_to" }] };
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "delegation_call",
            toolName: "delegate_to",
            input: { personaId: "research-lead", task: "Summarize the quarterly report." },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        text: "I couldn't reach the research lead, so I need your direction.",
        toolCalls: [],
      } as any);

    const result = await buildPersonaGraph(persona, defaultRegistry, undefined, async () =>
      Promise.reject(new Error("persona lookup failed")),
    ).invoke(
      { messages: [{ role: "user", content: "Ask the research lead." }] },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(result.messages.find((message) => message.role === "tool")?.content).toContain(
      "delegate errored: persona lookup failed",
    );
    expect(result.messages.at(-1)?.content).toBe("I couldn't reach the research lead, so I need your direction.");
  });

  it("maps a provider-safe MCP alias back to the intended registry tool during graph dispatch", async () => {
    const registry = new ToolRegistry();
    const id = "mcp:123e4567-e89b-12d3-a456-426614174000:files/read";
    const run = vi.fn(async () => ({ reached: id }));
    registry.register({
      id,
      riskClass: "read_only",
      description: "read",
      parameters: { type: "object" },
      origin: "mcp",
      run,
    });
    const alias = Object.keys(registry.aiSdkToolsFor([id]))[0]!;
    const persona: PersonaLike = { ...fakePersona, assignedToolIds: [{ toolId: id }] };
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "mcp_call", toolName: alias, input: { path: "a" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Read it.", toolCalls: [] } as any);

    const result = await buildPersonaGraph(persona, registry).invoke(
      { messages: [{ role: "user", content: "read" }] },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(run).toHaveBeenCalledWith({ path: "a" }, undefined);
    // toolName on the tool-result message must match the alias the
    // assistant's tool-call message used (see persona-graph.ts's callTools),
    // not the canonical registry id -- providers correlate a call/result
    // pair by toolCallId *and* toolName.
    expect(result.messages.find((message) => message.role === "tool")?.toolName).toBe(alias);
  });

  it("does not pass strict-schema null placeholders to tool implementations", async () => {
    const registry = new ToolRegistry();
    const run = vi.fn(async () => ({ ok: true }));
    registry.register({
      id: "optional_tool",
      riskClass: "read_only",
      description: "optional tool",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, sensitive: { type: "boolean" } },
      },
      run,
    });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "optional_call", toolName: "optional_tool", input: { id: "1", sensitive: null } }],
      } as any)
      .mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);

    await buildPersonaGraph({ ...fakePersona, assignedToolIds: [{ toolId: "optional_tool" }] }, registry).invoke(
      { messages: [{ role: "user", content: "run" }] },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(run).toHaveBeenCalledWith({ id: "1" }, undefined);
  });

  it("dispatches colliding punctuation-normalized MCP ids to the alias-selected spec", async () => {
    const registry = new ToolRegistry();
    const ids = ["mcp:server:read/file", "mcp/server/read:file"];
    const runs = ids.map(() => vi.fn(async () => ({ ok: true })));
    ids.forEach((id, index) =>
      registry.register({
        id,
        riskClass: "read_only",
        description: id,
        parameters: { type: "object" },
        origin: "mcp",
        run: runs[index]!,
      }),
    );
    const aliases = Object.keys(registry.aiSdkToolsFor(ids));
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "collision_call", toolName: aliases[1], input: {} }],
      } as any)
      .mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);

    await buildPersonaGraph({ ...fakePersona, assignedToolIds: ids.map((toolId) => ({ toolId })) }, registry).invoke(
      { messages: [{ role: "user", content: "run the second" }] },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(runs[0]).not.toHaveBeenCalled();
    expect(runs[1]).toHaveBeenCalledOnce();
  });

  it("reports a thrown MCP tool result as a failed audit with bounded detail", async () => {
    const registry = new ToolRegistry();
    const id = "mcp:server:failing";
    const failure = Object.assign(new Error("The MCP tool reported a failure"), {
      externalOutcomeKnown: true,
      detail: { isError: true, content: [{ type: "text", text: "not permitted" }] },
    });
    registry.register({
      id,
      riskClass: "read_only",
      externalSideEffect: true,
      description: "fails",
      parameters: { type: "object" },
      origin: "mcp",
      run: async () => Promise.reject(failure),
    });
    const [alias] = Object.keys(registry.aiSdkToolsFor([id]));
    const onToolExecuted = vi.fn(async () => {});
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "failed_call", toolName: alias, input: {} }],
      } as any)
      .mockResolvedValueOnce({ text: "Handled.", toolCalls: [] } as any);

    await buildPersonaGraph(
      { ...fakePersona, assignedToolIds: [{ toolId: id }] },
      registry,
      undefined,
      undefined,
      undefined,
      onToolExecuted,
    ).invoke({ messages: [{ role: "user", content: "run" }] }, { configurable: { thread_id: randomUUID() } });

    expect(onToolExecuted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: id,
        success: false,
        externalEffectCompleted: true,
        result: { error: "The MCP tool reported a failure", detail: failure.detail },
      }),
    );
  });

  it("executes each destructive tool call exactly once when a turn has two of them and both are approved across two resumes", async () => {
    // Regression test for the interrupt-replay bug: LangGraph replays
    // callTools from the top on every resume, but only interrupt() itself is
    // memoized. Before the two-phase (resolve-decisions / then-execute)
    // restructuring, the first destructive call's spec.run() would fire for
    // real a second time when the second destructive call was approved.
    let runCount = 0;
    const countingDestructive: ToolSpec = {
      id: "counting_destructive",
      riskClass: "destructive",
      description: "counts real executions",
      parameters: { type: "object", properties: {} },
      run: async (args) => {
        runCount += 1;
        return { ranWith: args, callNumber: runCount };
      },
    };
    const registry = new ToolRegistry();
    registry.register(countingDestructive);

    const persona: PersonaLike = {
      modelProvider: "anthropic",
      modelName: "m",
      systemPrompt: "S",
      assignedToolIds: [{ toolId: "counting_destructive" }],
    };

    const checkpointer = makeCheckpointer(process.env.DATABASE_URL!);
    await checkpointer.setup();
    try {
      const graph = buildPersonaGraph(persona, registry, checkpointer);
      // A fixed thread_id here previously made this test flaky against any
      // Postgres that persists across `vitest run` invocations (the
      // documented LOCAL_TEST_DATABASE_URL escape hatch in
      // tests/setup/global-setup.ts, for environments without a Docker
      // daemon) -- a second run replays this same test's own leftover
      // checkpoint state, silently doubling runCount and the tool-message
      // count. Real jobs never reuse a thread_id (job-repo.ts's createJob
      // always mints a fresh randomUUID); this test should not either.
      const config = { configurable: { thread_id: randomUUID() }, version: "v2" as const };

      vi.mocked(generateText).mockResolvedValueOnce({
        text: "",
        toolCalls: [
          { toolCallId: "call_1", toolName: "counting_destructive", input: { which: "first" } },
          { toolCallId: "call_2", toolName: "counting_destructive", input: { which: "second" } },
        ],
      } as any);

      await graph.invoke({ messages: [{ role: "user", content: "do two things" }] }, config);
      expect(runCount).toBe(0); // paused before executing anything

      await graph.invoke(new Command({ resume: { approved: true } }), config);
      expect(runCount).toBe(0); // Phase 1 not yet fully resolved — still paused on call_2

      vi.mocked(generateText).mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);
      const final = await graph.invoke(new Command({ resume: { approved: true } }), config);

      expect(runCount).toBe(2); // each destructive call executed exactly once, total
      const toolMessages = final.messages.filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(2);
    } finally {
      await checkpointer.end?.();
    }
  });

  it("degrades a tool revoked while the job was paused into a normal tool-error result, not a crash", async () => {
    // Regression test: mcp-routes.ts's approve/revoke/delete handlers call
    // registry.unregister/unregisterNamespace on the live defaultRegistry at
    // any time, including while a job is paused waiting_approval on exactly
    // that tool. Before this fix, resolveModelTool's throw on resume/replay
    // propagated past runAndReport's error boundary and failed the whole job.
    const registry = new ToolRegistry();
    const id = "mcp:server:revoked";
    registry.register({
      id,
      riskClass: "destructive",
      description: "will be revoked mid-flight",
      parameters: { type: "object", properties: {} },
      origin: "mcp",
      run: async () => ({ should: "not run" }),
    });
    const [alias] = Object.keys(registry.aiSdkToolsFor([id]));

    const persona: PersonaLike = { ...fakePersona, assignedToolIds: [{ toolId: id }] };
    const checkpointer = makeCheckpointer(process.env.DATABASE_URL!);
    await checkpointer.setup();
    try {
      const graph = buildPersonaGraph(persona, registry, checkpointer);
      const config = { configurable: { thread_id: randomUUID() }, version: "v2" as const };

      vi.mocked(generateText).mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: alias, input: {} }],
      } as any);
      await graph.invoke({ messages: [{ role: "user", content: "do the risky thing" }] }, config);

      // Revoked while the job sits paused waiting_approval on this call —
      // exactly mcp-routes.ts's PATCH .../tools/:toolId revoke path.
      registry.unregister(id);

      vi.mocked(generateText).mockResolvedValueOnce({ text: "Noted.", toolCalls: [] } as any);
      const final = await graph.invoke(new Command({ resume: { approved: true } }), config);

      const toolMessage = final.messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("tool no longer available");
      expect(final.messages[final.messages.length - 1]?.content).toBe("Noted.");
    } finally {
      await checkpointer.end?.();
    }
  });

  it("refuses a user-only tool for a cron job without prompting for approval", async () => {
    // requiresOrigin is enforced even though this tool is also
    // Ask-gated — the origin mismatch must win outright, never pause on
    // interrupt() for a decision that would be moot.
    const registry = new ToolRegistry();
    const run = vi.fn(async () => ({ should: "not run" }));
    registry.register({
      id: "user_only_tool",
      riskClass: "destructive",
      description: "only runs from a human-present job",
      parameters: { type: "object", properties: {} },
      requiresOrigin: ["user"],
      run,
    });
    const persona: PersonaLike = { ...fakePersona, assignedToolIds: [{ toolId: "user_only_tool" }] };
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "user_only_tool", input: {} }],
      } as any)
      .mockResolvedValueOnce({ text: "Can't do that from here.", toolCalls: [] } as any);

    const result = await buildPersonaGraph(persona, registry, undefined, undefined, {
      db: {} as DrizzleDb,
      personaId: "persona-1",
      jobId: "job-1",
      origin: "cron",
    }).invoke(
      { messages: [{ role: "user", content: "do the risky thing" }] },
      { configurable: { thread_id: randomUUID() } },
    );

    expect(run).not.toHaveBeenCalled();
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("tool requires a different job origin");
    // No interrupt(): the graph ran straight through to the final answer
    // instead of pausing waiting_approval.
    expect(result.messages[result.messages.length - 1]?.content).toBe("Can't do that from here.");
    // The other half of the enforcement, not just the tool-error fallback:
    // a cron job's model call should never have been offered this tool in
    // the first place (buildPersonaGraph's toolIds filter).
    expect(vi.mocked(generateText).mock.calls[0]![0].tools).not.toHaveProperty("user_only_tool");
  });

  it("runs a user-only tool normally when the job's origin is user", async () => {
    const registry = new ToolRegistry();
    const run = vi.fn(async () => ({ ok: true }));
    registry.register({
      id: "user_only_tool",
      riskClass: "read_only",
      description: "only runs from a human-present job",
      parameters: { type: "object", properties: {} },
      requiresOrigin: ["user"],
      run,
    });
    const persona: PersonaLike = { ...fakePersona, assignedToolIds: [{ toolId: "user_only_tool" }] };
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "user_only_tool", input: {} }],
      } as any)
      .mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);

    await buildPersonaGraph(persona, registry, undefined, undefined, {
      db: {} as DrizzleDb,
      personaId: "persona-1",
      jobId: "job-1",
      origin: "user",
    }).invoke({ messages: [{ role: "user", content: "do it" }] }, { configurable: { thread_id: randomUUID() } });

    expect(run).toHaveBeenCalledOnce();
    expect(vi.mocked(generateText).mock.calls[0]![0].tools).toHaveProperty("user_only_tool");
  });
});
