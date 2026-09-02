import { describe, it, expect, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { runJob } from "../src/orchestration/dispatcher.js";
import { readState } from "../src/personas/persona-state-repo.js";
import { listMemories } from "../src/personas/persona-memory-repo.js";
import { jobSummaryLabel, saveJobSummary } from "../src/personas/job-summary-memory.js";
import { defaultRegistry } from "../src/tools/registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

async function makePersona(toolIds: string[], reportsTo?: string | null, name = "A") {
  return createPersona(db(), {
    name,
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: toolIds.map((toolId) => ({ toolId })),
    reportsTo: reportsTo ?? null,
  });
}

describe("list_state / forget_state tools", () => {
  it("list_state surfaces a previously written key, and forget_state removes it", async () => {
    const persona = await makePersona(["write_state", "list_state", "forget_state", "read_state"]);

    const job1 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "write_state", input: { key: "inbox", content: "3 flagged" } }],
      } as any)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "list_state", input: {} }],
      } as any)
      .mockResolvedValueOnce({ text: "Noted.", toolCalls: [] } as any);
    await runJob(db(), job1, persona, defaultRegistry, undefined, "track this and list my keys");

    const job2 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c3", toolName: "forget_state", input: { key: "inbox" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Forgotten.", toolCalls: [] } as any);
    await runJob(db(), job2, persona, defaultRegistry, undefined, "forget the inbox key");

    expect(await readState(db(), persona.id, "inbox")).toBe("");
  });
});

describe("remember / recall / forget_memory tools", () => {
  it("a persona can remember a fact and later recall it in a different job", async () => {
    const persona = await makePersona(["remember", "recall"]);

    const job1 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "c1",
            toolName: "remember",
            input: { label: "prefers-concise", content: "Operator prefers concise replies" },
          },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "Noted.", toolCalls: [] } as any);
    await runJob(db(), job1, persona, defaultRegistry, undefined, "remember this about me");

    const job2 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "recall", input: { query: "concise" } }],
      } as any)
      .mockResolvedValueOnce({ text: "You prefer concise replies.", toolCalls: [] } as any);
    const updated = await runJob(
      db(),
      job2,
      persona,
      defaultRegistry,
      undefined,
      "what do you know about my preferences?",
    );

    expect(updated.status).toBe("done");
    const remembered = await listMemories(db(), persona.id);
    expect(remembered).toHaveLength(1);
  });

  it("forget_memory removes a remembered fact by label", async () => {
    const persona = await makePersona(["remember", "forget_memory"]);

    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "remember", input: { label: "temp", content: "a fact to forget" } }],
      } as any)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "forget_memory", input: { label: "temp" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);
    await runJob(db(), job, persona, defaultRegistry, undefined, "remember then forget this");

    expect(await listMemories(db(), persona.id)).toHaveLength(0);
  });

  it("does not let remember overwrite the reserved job-summary namespace", async () => {
    const persona = await makePersona(["remember"]);
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await saveJobSummary(db(), persona.id, job.id, { summary: "Internal summary.", summarizedMessageCount: 0 });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "c1",
            toolName: "remember",
            input: {
              label: jobSummaryLabel(job.id),
              content: "Summary through checkpoint message 999:\n\nSpoofed summary.",
            },
          },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "Could not overwrite it.", toolCalls: [] } as any);
    await runJob(db(), job, persona, defaultRegistry, undefined, "overwrite the job summary");

    const memories = await listMemories(db(), persona.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("Summary through checkpoint message 0:\n\nInternal summary.");
  });

  it("does not let forget_memory delete the reserved job-summary namespace", async () => {
    const persona = await makePersona(["forget_memory"]);
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await saveJobSummary(db(), persona.id, job.id, { summary: "Internal summary.", summarizedMessageCount: 0 });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "forget_memory", input: { label: jobSummaryLabel(job.id) } }],
      } as any)
      .mockResolvedValueOnce({ text: "Could not delete it.", toolCalls: [] } as any);
    await runJob(db(), job, persona, defaultRegistry, undefined, "delete the job summary");

    expect(await listMemories(db(), persona.id)).toHaveLength(1);
  });
});

describe("promote_memory tool", () => {
  it("returns not-promoted with no writes when the caller has no manager", async () => {
    const persona = await makePersona(["remember", "promote_memory"]);

    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "remember", input: { label: "finding", content: "a finding" } }],
      } as any)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "promote_memory", input: { label: "finding" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);
    const attempt = await runJob(db(), job, persona, defaultRegistry, undefined, "remember and promote this");

    expect(attempt.status).toBe("done");
    expect(await listMemories(db(), persona.id)).toHaveLength(1); // the caller's own remember() still landed
  });

  it("returns not-promoted with no writes when the label has no live memory", async () => {
    const manager = await makePersona([]);
    const delegate = await makePersona(["promote_memory"], manager.id);

    const job = await createJob(db(), { personaId: delegate.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "promote_memory", input: { label: "nope" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Done.", toolCalls: [] } as any);
    await runJob(db(), job, delegate, defaultRegistry, undefined, "promote a nonexistent memory");

    expect(await listMemories(db(), manager.id)).toHaveLength(0);
  });

  it("copies the delegate's memory up to the manager under a name-prefixed label, leaving the delegate's own memory untouched", async () => {
    const manager = await makePersona([]);
    const delegate = await makePersona(["remember", "promote_memory"], manager.id);

    const job = await createJob(db(), { personaId: delegate.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "c1",
            toolName: "remember",
            input: { label: "vendor-quote", content: "Acme quoted $4,200" },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "promote_memory", input: { label: "vendor-quote" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Promoted.", toolCalls: [] } as any);
    await runJob(db(), job, delegate, defaultRegistry, undefined, "remember the quote then promote it");

    const managerMemories = await listMemories(db(), manager.id);
    expect(managerMemories).toHaveLength(1);
    expect(managerMemories[0].label).toBe(`${delegate.name}: vendor-quote`);
    expect(managerMemories[0].content).toBe("Acme quoted $4,200");

    const delegateMemories = await listMemories(db(), delegate.id);
    expect(delegateMemories).toHaveLength(1);
    expect(delegateMemories[0].label).toBe("vendor-quote");
    expect(delegateMemories[0].content).toBe("Acme quoted $4,200");
  });

  it("does not promote a reserved job summary into a manager's ordinary memory", async () => {
    const manager = await makePersona([]);
    const delegate = await makePersona(["promote_memory"], manager.id);
    const job = await createJob(db(), { personaId: delegate.id, depth: 0, origin: "user" });
    await saveJobSummary(db(), delegate.id, job.id, {
      summary: "Delegate-only conversation summary.",
      summarizedMessageCount: 0,
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "promote_memory", input: { label: jobSummaryLabel(job.id) } }],
      } as any)
      .mockResolvedValueOnce({ text: "Could not promote it.", toolCalls: [] } as any);
    await runJob(db(), job, delegate, defaultRegistry, undefined, "promote the job summary");

    expect(await listMemories(db(), manager.id)).toHaveLength(0);
    expect(await listMemories(db(), delegate.id)).toHaveLength(1);
  });

  it("returns not-promoted (not a thrown error) when the caller's own name collides with the reserved namespace", async () => {
    // Regression test: the reserved-label guard only checked the caller's
    // own `label` argument, not the constructed destination label
    // `${caller.name}: ${memory.label}` — built from the *caller's* (the
    // promoting persona's, not the manager's) name. A persona literally
    // named "job-summary" produces a destination label starting with the
    // reserved "job-summary:" prefix even for an entirely ordinary label,
    // which used to make rememberMemory() throw instead of a clean
    // not-promoted result.
    const manager = await makePersona([]);
    const delegate = await makePersona(["remember", "promote_memory"], manager.id, "job-summary");

    const job = await createJob(db(), { personaId: delegate.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "remember", input: { label: "finding", content: "a finding" } }],
      } as any)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "promote_memory", input: { label: "finding" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Could not promote it.", toolCalls: [] } as any);
    const attempt = await runJob(db(), job, delegate, defaultRegistry, undefined, "remember and promote this");

    expect(attempt.status).toBe("done");
    expect(await listMemories(db(), manager.id)).toHaveLength(0);
    expect(await listMemories(db(), delegate.id)).toHaveLength(1); // the caller's own remember() still landed
  });
});

describe("memory bootstrap injection", () => {
  it("injects a persona's tracked state keys and remembered facts into the system prompt at job start", async () => {
    const persona = await makePersona(["write_state", "remember"]);
    const job0 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "write_state", input: { key: "deliveries", content: "widget" } }],
      } as any)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          { toolCallId: "c2", toolName: "remember", input: { label: "likes-tea", content: "Operator likes tea" } },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "Noted.", toolCalls: [] } as any);
    await runJob(db(), job0, persona, defaultRegistry, undefined, "set up my state and a memory");

    vi.mocked(generateText).mockClear();
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Hi again.", toolCalls: [] } as any);
    const job1 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await runJob(db(), job1, persona, defaultRegistry, undefined, "hello again");

    const call = vi.mocked(generateText).mock.calls[0][0] as { system: string };
    expect(call.system).toContain("deliveries");
    expect(call.system).toContain("Operator likes tea");
    expect(call.system).toMatch(/not an instruction/);
  });
});
