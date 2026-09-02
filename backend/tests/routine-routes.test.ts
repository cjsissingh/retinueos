import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { routineRoutes } from "../src/personas/routine-routes.js";
import { RoutineService } from "../src/control/routine-service.js";
import { listControlAuditEvents } from "../src/control/control-repo.js";
import { createJob, getJob } from "../src/jobs/job-repo.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual };
});

const { db } = useTestDb();

function buildApp(): Hono {
  const app = new Hono();
  app.route("/personas", personaRoutes(db()));
  app.route("/", routineRoutes(new RoutineService(db())));
  return app;
}

async function makePersona(app: Hono) {
  const res = await app.request("/personas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "A", role: "R", systemPrompt: "S", modelProvider: "anthropic", modelName: "m" }),
  });
  return res.json();
}

describe("routine routes", () => {
  it("creates a routine scoped to a persona and lists it back", async () => {
    const app = buildApp();
    const persona = await makePersona(app);

    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Morning Digest",
        cronSchedule: "0 8 * * *",
        promptTemplate: "Summarize the day ahead.",
      }),
    });
    expect(createRes.status).toBe(201);
    const routine = await createRes.json();
    expect(routine.personaId).toBe(persona.id);
    expect(routine.notifyRoutineRan).toBe(false);

    const listRes = await app.request(`/routines?personaId=${persona.id}`);
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(routine.id);
  });

  it("persists notifyRoutineRan on create and PATCH", async () => {
    const app = buildApp();
    const persona = await makePersona(app);

    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Fitness Check",
        cronSchedule: "30 20 * * *",
        promptTemplate: "Check the log.",
        notifyRoutineRan: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const routine = await createRes.json();
    expect(routine.notifyRoutineRan).toBe(true);

    const patchRes = await app.request(`/routines/${routine.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notifyRoutineRan: false }),
    });
    expect(patchRes.status).toBe(200);
    expect((await patchRes.json()).notifyRoutineRan).toBe(false);
  });

  it("creates a routine with kind: digest and persists it", async () => {
    const app = buildApp();
    const persona = await makePersona(app);

    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Morning Digest",
        cronSchedule: "0 8 * * *",
        promptTemplate: "unused for a digest routine",
        kind: "digest",
      }),
    });
    expect(createRes.status).toBe(201);
    const routine = await createRes.json();
    expect(routine.kind).toBe("digest");

    const getRes = await app.request(`/routines/${routine.id}`);
    const fetched = await getRes.json();
    expect(fetched.kind).toBe("digest");
  });

  it("defaults kind to job when not specified", async () => {
    const app = buildApp();
    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Check-in",
        cronSchedule: "0 8 * * *",
        promptTemplate: "Check in.",
      }),
    });
    const routine = await createRes.json();
    expect(routine.kind).toBe("job");
  });

  it("404s creating a routine for a persona that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request(`/personas/00000000-0000-0000-0000-000000000000/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on an invalid cron expression", async () => {
    const app = buildApp();
    const persona = await makePersona(app);
    const res = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "nonsense", promptTemplate: "Do the thing." }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes a routine", async () => {
    const app = buildApp();
    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();

    const delRes = await app.request(`/routines/${routine.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const getRes = await app.request(`/routines/${routine.id}`);
    expect(getRes.status).toBe(404);
  });

  it("preserves the successful delete response when a routine is already absent", async () => {
    const app = buildApp();

    const response = await app.request("/routines/00000000-0000-0000-0000-000000000000", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
  });

  it("retries a pending delete reconciliation through the route after its row is gone", async () => {
    const unschedule = vi.fn(() => {
      throw new Error("scheduler unavailable");
    });
    const replaceAll = vi.fn();
    const scheduler: import("../src/orchestration/scheduler.js").SchedulerHandle = {
      unschedule,
      registerAll: vi.fn(),
      replaceAll,
      start: vi.fn(),
      reschedule: vi.fn(),
      runNow: vi.fn(),
    };
    const app = new Hono();
    app.route("/personas", personaRoutes(db()));
    app.route("/", routineRoutes(new RoutineService(db(), scheduler)));
    const persona = await makePersona(app);
    const created = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await created.json();
    const headers = { "idempotency-key": "delete-1" };

    expect((await app.request(`/routines/${routine.id}`, { method: "DELETE", headers })).status).toBe(503);
    const retry = await app.request(`/routines/${routine.id}`, { method: "DELETE", headers });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "deleted" });
    expect(unschedule).toHaveBeenCalledTimes(1);
    expect(replaceAll).toHaveBeenCalledTimes(2);
    expect((await listControlAuditEvents(db(), { targetId: routine.id, limit: 100 })).items[0]).toMatchObject({
      action: "routine.delete",
      outcome: "succeeded",
      errorCategory: null,
    });
  });

  it("unschedules the routine's cron task from the scheduler on delete", async () => {
    // Regression test: deleting a routine used to leave its node-cron task
    // ticking forever in the scheduler's memory, since nothing told the
    // scheduler the routine was gone.
    const unschedule = vi.fn();
    const fakeScheduler: import("../src/orchestration/scheduler.js").SchedulerHandle = {
      unschedule,
      registerAll: vi.fn(),
      replaceAll: vi.fn(),
      start: vi.fn(),
      reschedule: vi.fn(),
      runNow: vi.fn(),
    };
    const app = new Hono();
    app.route("/personas", personaRoutes(db()));
    app.route("/", routineRoutes(new RoutineService(db(), fakeScheduler)));

    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();

    await app.request(`/routines/${routine.id}`, { method: "DELETE" });

    expect(unschedule).toHaveBeenCalledWith(routine.id);
  });

  it("deletes a routine that already has job history, clearing (not blocking on) the job's routineId", async () => {
    // Regression test for jobs.routineId's missing FK: before it existed,
    // this "worked" only because nothing enforced the reference at all,
    // leaving a deleted routine's id dangling on old job rows forever. Now
    // that a real FK (ON DELETE SET NULL) is in place, the same delete must
    // still succeed -- job history is a record of what happened, not
    // something a routine's own lifecycle should be able to block.
    const app = buildApp();
    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();
    const job = await createJob(db(), { personaId: persona.id, routineId: routine.id, depth: 0, origin: "cron" });

    const delRes = await app.request(`/routines/${routine.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const updatedJob = await getJob(db(), job.id);
    expect(updatedJob?.routineId).toBeNull();
  });

  it("PATCHes name/schedule/enabled and reschedules the live scheduler", async () => {
    const reschedule = vi.fn();
    const fakeScheduler: import("../src/orchestration/scheduler.js").SchedulerHandle = {
      unschedule: vi.fn(),
      registerAll: vi.fn(),
      replaceAll: vi.fn(),
      start: vi.fn(),
      reschedule,
      runNow: vi.fn(),
    };
    const app = new Hono();
    app.route("/personas", personaRoutes(db()));
    app.route("/", routineRoutes(new RoutineService(db(), fakeScheduler)));

    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();
    expect(routine.enabled).toBe(true);

    const patchRes = await app.request(`/routines/${routine.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, cronSchedule: "0 9 * * *" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated).toMatchObject({ enabled: false, cronSchedule: "0 9 * * *", name: "X" });
    expect(reschedule).toHaveBeenCalledWith(expect.objectContaining({ id: routine.id, enabled: false }));
  });

  it("400s a PATCH with an empty body", async () => {
    const app = buildApp();
    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();

    const patchRes = await app.request(`/routines/${routine.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(patchRes.status).toBe(400);
  });

  it("404s PATCHing a routine that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request(`/routines/00000000-0000-0000-0000-000000000000`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New name" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /routines/:id/run-now enqueues an immediate cron-origin job through the scheduler", async () => {
    const runNow = vi.fn();
    const fakeScheduler: import("../src/orchestration/scheduler.js").SchedulerHandle = {
      unschedule: vi.fn(),
      registerAll: vi.fn(),
      replaceAll: vi.fn(),
      start: vi.fn(),
      reschedule: vi.fn(),
      runNow,
    };
    const app = new Hono();
    app.route("/personas", personaRoutes(db()));
    app.route("/", routineRoutes(new RoutineService(db(), fakeScheduler)));

    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();

    const runRes = await app.request(`/routines/${routine.id}/run-now`, { method: "POST" });
    expect(runRes.status).toBe(202);
    expect(runNow).toHaveBeenCalledWith(routine.id);
  });

  it("404s run-now for a routine that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request(`/routines/00000000-0000-0000-0000-000000000000/run-now`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("503s run-now when no scheduler is available to actually run it", async () => {
    const app = buildApp(); // buildApp() passes no scheduler
    const persona = await makePersona(app);
    const createRes = await app.request(`/personas/${persona.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", cronSchedule: "0 8 * * *", promptTemplate: "Do the thing." }),
    });
    const routine = await createRes.json();

    const runRes = await app.request(`/routines/${routine.id}/run-now`, { method: "POST" });
    expect(runRes.status).toBe(503);
  });
});
