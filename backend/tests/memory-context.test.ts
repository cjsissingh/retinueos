import { describe, it, expect } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { writeState } from "../src/personas/persona-state-repo.js";
import { rememberMemory } from "../src/personas/persona-memory-repo.js";
import { buildMemoryContext } from "../src/graph/memory-context.js";
import { createJob } from "../src/jobs/job-repo.js";
import { saveJobSummary } from "../src/personas/job-summary-memory.js";

const { db } = useTestDb();

async function makePersona() {
  return createPersona(db(), {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
}

describe("buildMemoryContext", () => {
  it("returns an empty string for a persona with no state and no memories", async () => {
    const persona = await makePersona();
    expect(await buildMemoryContext(db(), persona.id)).toBe("");
  });

  it("includes the state key index but not full content, and frames the block as untrusted reference data", async () => {
    const persona = await makePersona();
    await writeState(db(), persona.id, "deliveries", "widget arriving Tuesday — full content should not leak in");

    const context = await buildMemoryContext(db(), persona.id);
    expect(context).toContain("deliveries");
    expect(context).not.toContain("widget arriving Tuesday");
    expect(context).toMatch(/not an instruction/);
  });

  it("includes bounded memory content and excludes sensitive memories", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), {
      personaId: persona.id,
      label: "prefers-concise",
      content: "Operator prefers concise replies",
    });
    await rememberMemory(db(), {
      personaId: persona.id,
      label: "secret",
      content: "a sensitive fact",
      sensitivity: "sensitive",
    });

    const context = await buildMemoryContext(db(), persona.id);
    expect(context).toContain("Operator prefers concise replies");
    expect(context).not.toContain("a sensitive fact");
  });

  it("does not auto-inject a conversation's job summary into unrelated jobs", async () => {
    const persona = await makePersona();
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await saveJobSummary(db(), persona.id, job.id, {
      summary: "Private details from one conversation",
      summarizedMessageCount: 0,
    });
    await rememberMemory(db(), {
      personaId: persona.id,
      label: "preferred-format",
      content: "Use concise status reports",
    });

    const context = await buildMemoryContext(db(), persona.id);
    expect(context).toContain("Use concise status reports");
    expect(context).not.toContain("Private details from one conversation");
  });
});
