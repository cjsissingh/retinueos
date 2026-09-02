import { describe, it, expect, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { runJob } from "../src/orchestration/dispatcher.js";
import { readState, writeState, listState } from "../src/personas/persona-state-repo.js";
import { defaultRegistry } from "../src/tools/registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

describe("persona_state repo", () => {
  it("read_state returns empty string for a key that was never written", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    expect(await readState(db(), persona.id, "nope")).toBe("");
  });

  it("write_state then read_state round-trips, and a second write overwrites wholesale", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    await writeState(db(), persona.id, "deliveries", "- widget, arriving Tuesday");
    expect(await readState(db(), persona.id, "deliveries")).toBe("- widget, arriving Tuesday");

    await writeState(db(), persona.id, "deliveries", "- widget, delivered");
    expect(await readState(db(), persona.id, "deliveries")).toBe("- widget, delivered");

    const all = await listState(db(), persona.id);
    expect(all).toHaveLength(1); // one row per key, not one per write
  });
});

describe("read_state/write_state tools end-to-end", () => {
  it("a persona can write and later read back its own state across two jobs", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "write_state" }, { toolId: "read_state" }],
    });

    const job1 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          { toolCallId: "c1", toolName: "write_state", input: { key: "inbox-suggestions", content: "3 flagged" } },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "Noted.", toolCalls: [] } as any);
    await runJob(db(), job1, persona, defaultRegistry, undefined, "log this");

    const job2 = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c2", toolName: "read_state", input: { key: "inbox-suggestions" } }],
      } as any)
      .mockResolvedValueOnce({ text: "You still have 3 flagged.", toolCalls: [] } as any);
    const updated = await runJob(db(), job2, persona, defaultRegistry, undefined, "what's flagged?");

    expect(updated.status).toBe("done");
    expect(await readState(db(), persona.id, "inbox-suggestions")).toBe("3 flagged");
  });
});
