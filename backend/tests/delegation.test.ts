import { describe, it, expect, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { getLastAssistantMessage } from "../src/jobs/message-repo.js";
import { checkDelegationAllowed } from "../src/orchestration/delegation.js";
import { runJob } from "../src/orchestration/dispatcher.js";
import { jobs } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { defaultRegistry } from "../src/tools/registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

async function makePersona() {
  return createPersona(db(), {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    // Unassigned tools are Blocked — these tests actually invoke delegate_to.
    assignedToolIds: [{ toolId: "delegate_to", permission: "allow" }],
  });
}

describe("checkDelegationAllowed", () => {
  it("allows delegation within limits", async () => {
    const persona = await makePersona();
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    const result = await checkDelegationAllowed(db(), job);
    expect(result.allowed).toBe(true);
  });

  it("rejects past max depth", async () => {
    const persona = await makePersona();
    const job = await createJob(db(), { personaId: persona.id, depth: 3, origin: "delegation" });
    const result = await checkDelegationAllowed(db(), job);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/depth/);
  });

  it("rejects past max descendants", async () => {
    const persona = await makePersona();
    const root = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    for (let i = 0; i < 10; i++) {
      await createJob(db(), { personaId: persona.id, parentJobId: root.id, depth: 1, origin: "delegation" });
    }
    const result = await checkDelegationAllowed(db(), root);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/descendant/);
  });
});

describe("runJob delegation end-to-end", () => {
  it("runs the delegate to completion inline and folds its real result back to the parent", async () => {
    const principal = await makePersona();
    const finance = await makePersona();
    const job = await createJob(db(), { personaId: principal.id, depth: 0, origin: "user" });

    // Delegation is synchronous now: the child's own generateText call
    // happens *before* the principal's second call, because onDelegate
    // awaits the child job to completion before returning a tool result.
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "delegate_to",
            input: { personaId: finance.id, task: "check finances" },
          },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "Finances look fine.", toolCalls: [] } as any) // the child's turn
      .mockResolvedValueOnce({ text: "Delegated: finances look fine.", toolCalls: [] } as any); // the parent's fold

    const updated = await runJob(db(), job, principal, defaultRegistry, undefined, "handle my finances");
    expect(updated.status).toBe("done");
    expect(await getLastAssistantMessage(db(), job.id)).toMatchObject({
      role: "assistant",
      content: "Delegated: finances look fine.",
    });

    const children = await db().select().from(jobs).where(eq(jobs.parentJobId, job.id));
    expect(children).toHaveLength(1);
    expect(children[0].personaId).toBe(finance.id);
    expect(children[0].depth).toBe(1);
    expect(children[0].status).toBe("done");

    // The parent's fold-turn actually received the delegate's real output —
    // not a "will be created later" placeholder — as the tool result.
    const foldCallArgs = vi.mocked(generateText).mock.calls[2]![0] as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const toolResultMessage = foldCallArgs.messages.find((m) => m.role === "tool");
    const parts = toolResultMessage!.content as Array<{
      output: { type: "json"; value: { delegated: boolean; result?: string } };
    }>;
    expect(parts[0]!.output.value.delegated).toBe(true);
    expect(parts[0]!.output.value.result).toBe("Finances look fine.");
  });

  it("resolves a human-readable persona slug before creating the delegated job", async () => {
    vi.mocked(generateText).mockClear();
    const principal = await makePersona();
    const researchLead = await createPersona(db(), {
      name: "Research Lead",
      role: "Researcher",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: principal.id, depth: 0, origin: "user" });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "delegate_to",
            input: { personaId: "research-lead", task: "summarize the quarterly report" },
          },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "The key risks are documented.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "The research lead documented the key risks.", toolCalls: [] } as any);

    const updated = await runJob(
      db(),
      job,
      principal,
      defaultRegistry,
      undefined,
      "ask the research lead to summarize the quarterly report",
    );

    expect(updated.status).toBe("done");
    const children = await db().select().from(jobs).where(eq(jobs.parentJobId, job.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ personaId: researchLead.id, status: "done" });
  });

  it("rejects delegation to a persona id that doesn't exist, instead of orphaning a running child job", async () => {
    vi.mocked(generateText).mockClear();
    const principal = await makePersona();
    const job = await createJob(db(), { personaId: principal.id, depth: 0, origin: "user" });
    const bogusPersonaId = "00000000-0000-0000-0000-000000000000";

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "delegate_to",
            input: { personaId: bogusPersonaId, task: "check finances" },
          },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "That persona doesn't exist; handling it myself.", toolCalls: [] } as any);

    const updated = await runJob(db(), job, principal, defaultRegistry, undefined, "handle my finances");
    expect(updated.status).toBe("done");

    // No child job was created — the old behavior created one and left it
    // stuck at "running" forever, since nothing ever ran it.
    const children = await db().select().from(jobs).where(eq(jobs.parentJobId, job.id));
    expect(children).toHaveLength(0);

    const secondCallArgs = vi.mocked(generateText).mock.calls[1]![0] as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const toolResultMessage = secondCallArgs.messages.find((m) => m.role === "tool");
    const parts = toolResultMessage!.content as Array<{
      output: { type: "json"; value: { delegated: boolean; reason?: string } };
    }>;
    expect(parts[0]!.output.value.delegated).toBe(false);
    expect(parts[0]!.output.value.reason).toMatch(/no persona/);
  });

  it("surfaces a rejected delegation (depth limit) to the model instead of lying about success", async () => {
    vi.mocked(generateText).mockClear();
    const principal = await makePersona();
    const finance = await makePersona();
    // depth 3 is already at MAX_DEPTH, so delegating from here must be rejected.
    const job = await createJob(db(), { personaId: principal.id, depth: 3, origin: "delegation" });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "delegate_to",
            input: { personaId: finance.id, task: "check finances" },
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        text: "Understood, I cannot delegate further; handling it myself.",
        toolCalls: [],
      } as any);

    const updated = await runJob(db(), job, principal, defaultRegistry, undefined, "handle my finances");
    expect(updated.status).toBe("done");

    // No child job was created.
    const children = await db().select().from(jobs).where(eq(jobs.parentJobId, job.id));
    expect(children).toHaveLength(0);

    // The model's second call received the rejection as the tool result.
    const secondCallArgs = vi.mocked(generateText).mock.calls[1]![0] as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const toolResultMessage = secondCallArgs.messages.find((m) => m.role === "tool");
    expect(toolResultMessage).toBeDefined();
    const parts = toolResultMessage!.content as Array<{
      output: { type: "json"; value: { delegated: boolean; reason?: string } };
    }>;
    expect(parts[0]!.output.value.delegated).toBe(false);
    expect(parts[0]!.output.value.reason).toMatch(/depth/);
  });
});
