import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { claimQueuedJob, createJob, getJob, transitionJobStatus } from "../src/jobs/job-repo.js";
import { listMessagesByJob } from "../src/jobs/message-repo.js";

const { db } = useTestDb();

async function createTestJob() {
  const persona = await createPersona(db(), {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  return createJob(db(), { personaId: persona.id, depth: 0, origin: "user", prompt: "hello" });
}

describe("job status transitions", () => {
  it("creates jobs as queued and lets exactly one concurrent executor claim one", async () => {
    const job = await createTestJob();
    expect(job.status).toBe("queued");

    const claims = await Promise.all([claimQueuedJob(db(), job.id), claimQueuedJob(db(), job.id)]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.status).toBe("running");
    expect((await getJob(db(), job.id))?.status).toBe("running");
  });

  it("does not apply a transition when the current status differs from the expected status", async () => {
    const job = await createTestJob();

    expect(await transitionJobStatus(db(), job.id, "running", "done")).toBeUndefined();
    expect((await getJob(db(), job.id))?.status).toBe("queued");
  });

  it("seeds the message history with the opening prompt on creation", async () => {
    const job = await createTestJob();
    const messages = await listMessagesByJob(db(), job.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "hello" });
  });
});
