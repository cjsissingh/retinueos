import { describe, it, expect } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { recordModelCall, listModelCallsByJob, listModelCallsByPersona } from "../src/models/model-call-repo.js";

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

describe("model-call-repo", () => {
  it("records a call and lists it back by job, newest first", async () => {
    const persona = await makePersona();
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });

    const first = await recordModelCall(db(), {
      jobId: job.id,
      personaId: persona.id,
      provider: "anthropic",
      model: "m",
      latencyMs: 100,
      finishReason: "stop",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    const second = await recordModelCall(db(), {
      jobId: job.id,
      personaId: persona.id,
      provider: "anthropic",
      model: "m",
      latencyMs: 50,
      error: "timeout",
    });

    const calls = await listModelCallsByJob(db(), job.id);
    expect(calls.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(calls[1]).toMatchObject({ finishReason: "stop", totalTokens: 15, error: null });
    expect(calls[0]).toMatchObject({ finishReason: null, totalTokens: null, error: "timeout" });
  });

  it("lists calls scoped to a persona across multiple jobs", async () => {
    const persona = await makePersona();
    const other = await makePersona();
    const jobA = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    const jobB = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    const jobC = await createJob(db(), { personaId: other.id, depth: 0, origin: "user" });

    for (const job of [jobA, jobB, jobC]) {
      await recordModelCall(db(), { jobId: job.id, personaId: job.personaId, provider: "p", model: "m", latencyMs: 1 });
    }

    const forPersona = await listModelCallsByPersona(db(), persona.id);
    expect(forPersona).toHaveLength(2);
    expect(forPersona.every((c) => c.personaId === persona.id)).toBe(true);
  });
});
