import { describe, it, expect, vi } from "vitest";
import cron from "node-cron";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createRoutine, getRoutine, updateRoutine, updateRoutineFired } from "../src/personas/routine-repo.js";
import { PersonaScheduler } from "../src/orchestration/scheduler.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { listDigests } from "../src/notifications/digest-repo.js";
import { listJobAttempts } from "../src/jobs/job-attempt-repo.js";
import { listMessagesByJob } from "../src/jobs/message-repo.js";
import "../src/tools/builtin.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

describe("PersonaScheduler", () => {
  it("fires a routine by durably enqueueing it for a worker", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Check-in",
      cronSchedule: "* * * * *",
      promptTemplate: "Perform your scheduled check-in.",
    });
    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    scheduler.registerAll([routine]);
    await scheduler.runNow(routine.id);

    const jobsRes = await db().query.jobs.findMany();
    const cronJobs = jobsRes.filter((j) => j.origin === "cron" && j.personaId === persona.id);
    expect(cronJobs).toHaveLength(1);
    expect(cronJobs[0].status).toBe("queued");
    expect(cronJobs[0].routineId).toBe(routine.id);

    const updated = await getRoutine(db(), routine.id);
    expect(updated?.lastFiredAt).not.toBeNull();
    expect(updated?.lastSummary).toBe("");
    // Symmetric counterpart to the digest test's "no jobs row" assertion --
    // a job routine must not also write a digests row.
    expect(await listDigests(db(), persona.id)).toHaveLength(0);
  });

  it("seeds a routine job from its instruction instead of prior assistant output", async () => {
    // This fails if runNow chooses routine.lastSummary as the seed message:
    // createQueuedJob persists that seed as the opening user chat message.
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Workout",
      cronSchedule: "* * * * *",
      promptTemplate: "Create a workout.",
    });
    await updateRoutineFired(db(), routine.id, "Previous persona response.");

    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    await scheduler.runNow(routine.id);

    const [job] = (await db().query.jobs.findMany()).filter((candidate) => candidate.routineId === routine.id);
    expect(job?.prompt).toBe("Create a workout.");

    const messages = await listMessagesByJob(db(), job!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "Create a workout." });
  });

  it("marks an opted-in routine's queued attempt for outcome notification", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Fitness Check",
      cronSchedule: "* * * * *",
      promptTemplate: "Check the fitness log.",
      notifyRoutineRan: true,
    });

    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    await scheduler.runNow(routine.id);

    const [job] = (await db().query.jobs.findMany()).filter((candidate) => candidate.routineId === routine.id);
    const attempts = await listJobAttempts(db(), job!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.notifyOnOutcome).toBe(true);
  });

  it("fires a digest routine via generateDigest instead of creating a job", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Morning Digest",
      cronSchedule: "0 8 * * *",
      promptTemplate: "unused for a digest routine",
      kind: "digest",
    });
    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    scheduler.registerAll([routine]);
    await scheduler.runNow(routine.id);

    const jobsRes = await db().query.jobs.findMany();
    const cronJobs = jobsRes.filter((j) => j.personaId === persona.id);
    expect(cronJobs).toHaveLength(0);

    const digests = await listDigests(db(), persona.id);
    expect(digests).toHaveLength(1);
    expect(digests[0].routineId).toBe(routine.id);

    const updated = await getRoutine(db(), routine.id);
    expect(updated?.lastFiredAt).not.toBeNull();
  });

  it("does not execute the model in the scheduler's cron callback", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Flaky",
      cronSchedule: "* * * * *",
      promptTemplate: "Perform your scheduled check-in.",
    });
    const callsBefore = vi.mocked(generateText).mock.calls.length;

    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    scheduler.registerAll([routine]);
    await expect(scheduler.runNow(routine.id)).resolves.toBeUndefined();

    const jobsRes = await db().query.jobs.findMany();
    const cronJobs = jobsRes.filter((j) => j.origin === "cron" && j.personaId === persona.id);
    expect(cronJobs).toHaveLength(1);
    expect(cronJobs[0].status).toBe("queued");
    expect(vi.mocked(generateText).mock.calls.length).toBe(callsBefore);
  });

  it("does not throw when a routine has an invalid cronSchedule (defense in depth)", async () => {
    // RoutineCreateSchema now validates cronSchedule at creation time, but a
    // row could predate that validation (or be written directly). This
    // bypasses the repo/schema entirely to simulate that: registerAll must
    // skip the bad routine instead of throwing, which would otherwise crash
    // the process before `serve()` is even reached (a permanent boot loop).
    const persona = await createPersona(db(), {
      name: "Bad",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Broken",
      cronSchedule: "not a valid cron expression",
      promptTemplate: "Check in.",
    });

    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    expect(() => scheduler.registerAll([routine])).not.toThrow();
  });

  it("unschedule stops a routine's cron task and removes it, and is a no-op for an unknown id", async () => {
    // Deleting a routine (routine-routes.ts's DELETE /routines/:id) has no
    // other handle on this in-memory scheduler -- without unschedule, the
    // node-cron task backing a deleted routine just keeps ticking forever.
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Check-in",
      cronSchedule: "* * * * *",
      promptTemplate: "Perform your scheduled check-in.",
    });

    // Spy on cron.schedule *before* registerAll runs, so its mock.results
    // captures the real ScheduledTask node-cron hands back -- the only way
    // to observe unschedule()'s effect without adding a test-only accessor
    // to PersonaScheduler's private `tasks` map.
    const scheduleSpy = vi.spyOn(cron, "createTask");
    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    scheduler.registerAll([routine]);
    const task = scheduleSpy.mock.results[0]!.value as { stop: () => void };
    const stopSpy = vi.spyOn(task, "stop");

    scheduler.unschedule(routine.id);
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Already removed -- a second call must not throw or double-stop it.
    expect(() => scheduler.unschedule(routine.id)).not.toThrow();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // An id that was never registered at all is likewise a no-op.
    expect(() => scheduler.unschedule("00000000-0000-0000-0000-000000000000")).not.toThrow();

    scheduleSpy.mockRestore();
    stopSpy.mockRestore();
  });

  it("does not register a cron task for a disabled routine", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Paused",
      cronSchedule: "* * * * *",
      promptTemplate: "Check in.",
    });
    await updateRoutine(db(), routine.id, { enabled: false });
    const disabled = await getRoutine(db(), routine.id);

    const scheduleSpy = vi.spyOn(cron, "createTask");
    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    scheduler.registerAll([disabled!]);

    expect(scheduleSpy).not.toHaveBeenCalled();
    // unschedule on an id that was never registered is a documented no-op --
    // this just confirms disabling really did skip registration, not that
    // some task quietly got created and stopped again.
    expect(() => scheduler.unschedule(routine.id)).not.toThrow();

    scheduleSpy.mockRestore();
  });

  it("reschedule swaps out a routine's live cron task for its updated row", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Check-in",
      cronSchedule: "* * * * *",
      promptTemplate: "Check in.",
    });

    const scheduleSpy = vi.spyOn(cron, "createTask");
    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    scheduler.registerAll([routine]);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const firstTask = scheduleSpy.mock.results[0]!.value as { stop: () => void };
    const firstStop = vi.spyOn(firstTask, "stop");

    const updated = await updateRoutine(db(), routine.id, { cronSchedule: "0 8 * * *" });
    scheduler.reschedule(updated!);

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledTimes(2);
    expect(scheduleSpy.mock.calls[1]![0]).toBe("0 8 * * *");

    // Rescheduling to disabled tears the task down and registers nothing new.
    const disabled = await updateRoutine(db(), routine.id, { enabled: false });
    scheduler.reschedule(disabled!);
    expect(scheduleSpy).toHaveBeenCalledTimes(2);

    scheduleSpy.mockRestore();
  });

  it("replaces every live task by stopping, registering committed routines, and restarting", async () => {
    const scheduler = new PersonaScheduler(db(), defaultRegistry, undefined);
    const calls: string[] = [];
    const routines = [] as import("../src/db/schema.js").RoutineRow[];
    vi.spyOn(scheduler, "stop").mockImplementation(() => {
      calls.push("stop");
    });
    vi.spyOn(scheduler, "registerAll").mockImplementation((registered) => {
      expect(registered).toBe(routines);
      calls.push("register");
    });
    vi.spyOn(scheduler, "start").mockImplementation(() => {
      calls.push("start");
    });

    scheduler.replaceAll(routines);

    expect(calls).toEqual(["stop", "register", "start"]);
  });
});
