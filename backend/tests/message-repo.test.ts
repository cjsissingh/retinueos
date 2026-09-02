import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { createMessage, listMessagesByJob, getLastAssistantMessage } from "../src/jobs/message-repo.js";

const { db } = useTestDb();

async function makeJob() {
  const persona = await createPersona(db(), {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  // No prompt -- an empty starting point this test seeds itself, so
  // ordering assertions aren't at the mercy of createJob's own seed message.
  return createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
}

describe("message-repo", () => {
  it("lists messages for one job oldest first, unaffected by insert order across jobs", async () => {
    const jobA = await makeJob();
    const jobB = await makeJob();
    const base = new Date("2026-08-22T12:00:00.000Z");

    await createMessage(db(), jobB.id, "user", "for B", base);
    await createMessage(db(), jobA.id, "user", "first", base);
    await createMessage(db(), jobA.id, "assistant", "second", new Date(base.getTime() + 1));

    const messages = await listMessagesByJob(db(), jobA.id);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["assistant", "second"],
    ]);
  });

  it("defaults createMessage's timestamp to now when none is given", async () => {
    const job = await makeJob();
    const before = new Date();
    const message = await createMessage(db(), job.id, "user", "hi");
    expect(message.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("getLastAssistantMessage returns the most recent message only when it's from the assistant", async () => {
    const job = await makeJob();
    const base = new Date("2026-08-22T12:00:00.000Z");
    await createMessage(db(), job.id, "user", "question", base);

    expect(await getLastAssistantMessage(db(), job.id)).toBeUndefined();

    await createMessage(db(), job.id, "assistant", "answer", new Date(base.getTime() + 1));
    expect(await getLastAssistantMessage(db(), job.id)).toMatchObject({ role: "assistant", content: "answer" });

    // A later user message (e.g. a continuation queued right after) means
    // the assistant no longer has the last word -- undefined again, not a
    // stale answer from earlier in the same chat.
    await createMessage(db(), job.id, "user", "follow-up", new Date(base.getTime() + 2));
    expect(await getLastAssistantMessage(db(), job.id)).toBeUndefined();
  });

  it("returns undefined for a job with no messages at all", async () => {
    const job = await makeJob();
    expect(await getLastAssistantMessage(db(), job.id)).toBeUndefined();
    expect(await listMessagesByJob(db(), job.id)).toEqual([]);
  });
});
