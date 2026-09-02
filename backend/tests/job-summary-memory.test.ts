import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { personaMemories } from "../src/db/schema.js";
import { jobSummaryLabel, loadJobSummary, parseJobSummary } from "../src/personas/job-summary-memory.js";

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

describe("parseJobSummary", () => {
  it("rejects a positive checkpoint boundary with an empty summary", () => {
    expect(parseJobSummary("Summary through checkpoint message 8:\n\n   ")).toBeUndefined();
  });

  it("rejects a summary larger than the graph's maximum summary size", () => {
    expect(parseJobSummary(`Summary through checkpoint message 2:\n\n${"s".repeat(4_001)}`)).toBeUndefined();
  });

  it("does not load an exact-label summary whose source provenance names another job", async () => {
    const persona = await makePersona();
    const targetJob = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    const otherJob = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await db()
      .insert(personaMemories)
      .values({
        personaId: persona.id,
        label: jobSummaryLabel(targetJob.id),
        content: "Summary through checkpoint message 2:\n\nWrong provenance.",
        sourceJobId: otherJob.id,
      });

    expect(await loadJobSummary(db(), persona.id, targetJob.id)).toBeUndefined();
  });
});
