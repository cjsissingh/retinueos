import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { writeState } from "../src/personas/persona-state-repo.js";
import { createJob, transitionJobStatus } from "../src/jobs/job-repo.js";
import { createRoutine } from "../src/personas/routine-repo.js";
import { generateDigest } from "../src/notifications/digest-generator.js";
import { listDigests } from "../src/notifications/digest-repo.js";
import { listNotifications } from "../src/notifications/notify.js";
import { personaState } from "../src/db/schema.js";

const { db } = useTestDb();

async function makePersona(name = "Assistant") {
  return createPersona(db(), {
    name,
    role: "Chief of staff",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
}

describe("generateDigest", () => {
  afterEach(() => {
    delete process.env.NOTIFY_WEBHOOK_URL;
  });

  it("throws for an unknown persona instead of writing a digest for nobody", async () => {
    await expect(generateDigest(db(), "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no persona/);
  });

  it("reports nothing new when state is fresh and jobs are unremarkable", async () => {
    const persona = await makePersona();
    await writeState(db(), persona.id, "inbox-suggestions", "nothing pending");

    const digest = await generateDigest(db(), persona.id);
    expect(digest.content).toContain("nothing new to report");
    expect(digest.personaId).toBe(persona.id);

    const stored = await listDigests(db(), persona.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(digest.id);
  });

  it("surfaces stale state plus waiting and failed jobs", async () => {
    const persona = await makePersona();
    await writeState(db(), persona.id, "deliveries", "package X ordered, not arrived");
    // writeState always stamps "now" -- backdate it directly to simulate a
    // loop item that's been sitting untouched.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db().update(personaState).set({ updatedAt: twoDaysAgo }).where(eq(personaState.personaId, persona.id));

    const waitingJob = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await transitionJobStatus(db(), waitingJob.id, "queued", "waiting_approval");
    const failedJob = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await transitionJobStatus(db(), failedJob.id, "queued", "failed", "boom");

    const digest = await generateDigest(db(), persona.id, { push: false });
    expect(digest.content).toContain('"deliveries"');
    expect(digest.content).toMatch(/untouched 2 days/);
    expect(digest.content).toContain("Waiting on your approval: 1 job");
    expect(digest.content).toContain("Failed recently: 1 job");

    // push: false means no notify() teaser was sent for this call.
    expect(await listNotifications(db())).toHaveLength(0);
  });

  it("does not push a teaser unless the caller explicitly requests one", async () => {
    const persona = await makePersona();
    await generateDigest(db(), persona.id);

    expect((await listNotifications(db())).filter((n) => n.personaId === persona.id)).toHaveLength(0);

    await generateDigest(db(), persona.id, { push: true });

    const notifications = await listNotifications(db());
    const forPersona = notifications.filter((n) => n.personaId === persona.id);
    expect(forPersona).toHaveLength(1);
    expect(forPersona[0]!.message).toContain(`${persona.name} digest:`);
    expect(forPersona[0]!.kind).toBe("routine_ran");
  });

  it("stamps the digest with routineId when one is given", async () => {
    const persona = await makePersona();
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Morning Digest",
      cronSchedule: "0 8 * * *",
      promptTemplate: "n/a",
    });
    const digest = await generateDigest(db(), persona.id, { routineId: routine.id, push: false });
    expect(digest.routineId).toBe(routine.id);
  });
});
