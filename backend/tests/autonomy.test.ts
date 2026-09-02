import { describe, it, expect, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona, getPersona, updatePersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { runJob } from "../src/orchestration/dispatcher.js";
import { listToolCallsByJob } from "../src/tool-calls/tool-call-repo.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { persistAlwaysAllow } from "../src/tools/autonomy.js";
import "../src/tools/builtin.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

describe("per-persona autonomy tiers", () => {
  it("a reversible tool runs directly (no gating) when the persona has no override", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "write_state" }],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "write_state", input: { key: "notes", content: "hi" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Saved.", toolCalls: [] } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "note this down");
    expect(updated.status).toBe("done"); // never paused — ran directly

    const calls = await listToolCallsByJob(db(), job.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("executed");
    expect(calls[0]!.result).toEqual({ key: "notes", status: "written" });
  });

  it("the same reversible tool gates for a persona with an approval_required override", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "write_state", autonomy: "approval_required" }],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolCallId: "call_1", toolName: "write_state", input: { key: "notes", content: "hi" } }],
    } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "note this down");
    expect(updated.status).toBe("waiting_approval");

    const calls = await listToolCallsByJob(db(), job.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("pending_approval");
    expect(calls[0]!.riskClass).toBe("reversible");
  });

  it("a destructive tool still gates even with no persona override at all", async () => {
    // The ceiling: destructive always gates, and there is no override value
    // that could ever relax it (see AssignedToolConfig's doc comment).
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "send_email" }],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolCallId: "call_1", toolName: "send_email", input: { to: "a@b.com", subject: "s", body: "b" } }],
    } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "email a@b.com");
    expect(updated.status).toBe("waiting_approval");
  });

  it("a blocked (unassigned) reversible tool does not execute even if the model names it", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "write_state", input: { key: "notes", content: "hi" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Couldn't.", toolCalls: [] } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "note this down");
    expect(updated.status).toBe("done");

    const calls = await listToolCallsByJob(db(), job.id);
    expect(calls).toHaveLength(0);
  });

  it("always-allow persists on a subsequent routine run so the same tool does not re-prompt", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "write_state", autonomy: "approval_required" }],
    });
    const first = await createJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "cron",
      prompt: "note this down",
    });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolCallId: "call_1", toolName: "write_state", input: { key: "notes", content: "hi" } }],
    } as any);

    const paused = await runJob(db(), first, persona, defaultRegistry, undefined, "note this down");
    expect(paused.status).toBe("waiting_approval");

    const nextTools = persistAlwaysAllow(persona.assignedToolIds, "write_state", "reversible");
    expect(nextTools).toBeTruthy();
    if (!nextTools) throw new Error("persistAlwaysAllow refused a reversible assigned tool");
    await updatePersona(db(), persona.id, { assignedToolIds: nextTools });

    const refreshed = await getPersona(db(), persona.id);
    expect(refreshed?.assignedToolIds).toEqual([{ toolId: "write_state", permission: "allow" }]);

    const second = await createJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "cron",
      prompt: "note this down again",
    });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_2", toolName: "write_state", input: { key: "notes", content: "again" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Saved again.", toolCalls: [] } as any);

    const done = await runJob(db(), second, refreshed!, defaultRegistry, undefined, "note this down again");
    expect(done.status).toBe("done");
    const calls = await listToolCallsByJob(db(), second.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("executed");
  });
});
