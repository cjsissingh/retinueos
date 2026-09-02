import { describe, expect, it, vi } from "vitest";
import { listControlAuditEvents } from "../src/control/control-repo.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createRoutine, getRoutine, listRoutines } from "../src/personas/routine-repo.js";
import { RoutineService } from "../src/control/routine-service.js";
import type { SchedulerHandle } from "../src/orchestration/scheduler.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();

function schedulerFake(overrides: Partial<SchedulerHandle> = {}): SchedulerHandle {
  return {
    registerAll: vi.fn(),
    start: vi.fn(),
    unschedule: vi.fn(),
    reschedule: vi.fn(),
    runNow: vi.fn(),
    replaceAll: vi.fn(),
    ...overrides,
  };
}

async function persona(name: string) {
  return createPersona(db(), {
    name,
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
}

describe("RoutineService", () => {
  it("lets an owner list and read every routine", async () => {
    const first = await persona("First");
    const second = await persona("Second");
    const firstRoutine = await createRoutine(db(), {
      personaId: first.id,
      name: "First routine",
      cronSchedule: "0 8 * * *",
      promptTemplate: "First",
    });
    const secondRoutine = await createRoutine(db(), {
      personaId: second.id,
      name: "Second routine",
      cronSchedule: "0 9 * * *",
      promptTemplate: "Second",
    });
    const service = new RoutineService(db(), schedulerFake());
    const owner = { kind: "owner", source: "rest" } as const;

    expect(await service.listAll(owner)).toEqual(expect.arrayContaining([firstRoutine, secondRoutine]));
    expect(await service.get(owner, firstRoutine.id)).toEqual(firstRoutine);
  });

  it("denies MCP routine mutations without the routine write scope", async () => {
    const target = await persona("Target");
    const routine = await createRoutine(db(), {
      personaId: target.id,
      name: "Routine",
      cronSchedule: "0 8 * * *",
      promptTemplate: "Prompt",
    });
    const service = new RoutineService(db(), schedulerFake());

    await expect(
      service.update(
        { kind: "mcp_client", clientId: "client-1", scopes: ["routines:read"] },
        routine.id,
        { name: "Denied" },
        "call-1",
      ),
    ).rejects.toMatchObject({ category: "insufficient_scope" });
  });

  it("keeps persona actors self-only on create even when another persona id is supplied", async () => {
    const self = await persona("Self");
    const other = await persona("Other");
    const service = new RoutineService(db(), schedulerFake());

    const created = await service.create(
      { kind: "persona", personaId: self.id, jobId: "job-1", toolCallId: "call-1" },
      other.id,
      { name: "Self routine", cronSchedule: "0 8 * * *", promptTemplate: "Prompt" },
      "key-1",
    );

    expect(created).toMatchObject({ personaId: self.id, enabled: true });
  });

  it("rejects a persona actor updating another persona's routine", async () => {
    const self = await persona("Self");
    const other = await persona("Other");
    const routine = await createRoutine(db(), {
      personaId: self.id,
      name: "Routine",
      cronSchedule: "0 8 * * *",
      promptTemplate: "Prompt",
    });
    const service = new RoutineService(db(), schedulerFake());

    await expect(
      service.update(
        { kind: "persona", personaId: other.id, jobId: "job-1", toolCallId: "call-1" },
        routine.id,
        { name: "stolen" },
        "call-1",
      ),
    ).rejects.toMatchObject({ category: "ownership_violation" });
  });

  it("updates, pauses, resumes, runs, and deletes while recording settled audits", async () => {
    const target = await persona("Target");
    const scheduler = schedulerFake();
    const service = new RoutineService(db(), scheduler);
    const owner = { kind: "owner", source: "rest" } as const;
    const created = await service.create(
      owner,
      target.id,
      { name: "Routine", cronSchedule: "0 8 * * *", promptTemplate: "Prompt" },
      "create-1",
    );

    const updated = await service.update(owner, created.id, { name: "Renamed" }, "update-1");
    const paused = await service.pause(owner, created.id, "pause-1");
    const resumed = await service.resume(owner, created.id, "resume-1");
    await service.runNow(owner, created.id, "run-1");
    await service.delete(owner, created.id, "delete-1");

    expect(updated.name).toBe("Renamed");
    expect(paused.enabled).toBe(false);
    expect(resumed.enabled).toBe(true);
    expect(scheduler.registerAll).toHaveBeenCalledWith([created]);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    expect(scheduler.reschedule).toHaveBeenCalledTimes(3);
    expect(scheduler.runNow).toHaveBeenCalledWith(created.id);
    expect(scheduler.unschedule).toHaveBeenCalledWith(created.id);
    expect(await getRoutine(db(), created.id)).toBeUndefined();

    const audits = await listControlAuditEvents(db(), { targetId: created.id, limit: 100 });
    expect(audits.items.map((event) => [event.action, event.outcome])).toEqual(
      expect.arrayContaining([
        ["routine.create", "succeeded"],
        ["routine.update", "succeeded"],
        ["routine.pause", "succeeded"],
        ["routine.resume", "succeeded"],
        ["routine.run", "succeeded"],
        ["routine.delete", "succeeded"],
      ]),
    );
  });

  it("replays an idempotent create without adding another routine", async () => {
    const target = await persona("Target");
    const scheduler = schedulerFake();
    const service = new RoutineService(db(), scheduler);
    const owner = { kind: "owner", source: "rest" } as const;
    const input = { name: "Routine", cronSchedule: "0 8 * * *", promptTemplate: "Prompt" };

    const first = await service.create(owner, target.id, input, "create-1");
    const replay = await service.create(owner, target.id, input, "create-1");

    expect(replay).toEqual(first);
    expect(await listRoutines(db())).toHaveLength(1);
    expect(scheduler.registerAll).toHaveBeenCalledTimes(1);
  });

  it("creates a disabled routine atomically without registering it and replays one create operation", async () => {
    const target = await persona("Paused");
    const scheduler = schedulerFake();
    const service = new RoutineService(db(), scheduler);
    const owner = { kind: "owner", source: "rest" } as const;
    const input = {
      name: "Initially paused",
      cronSchedule: "0 8 * * *",
      promptTemplate: "Wait",
      enabled: false,
    };

    const first = await service.create(owner, target.id, input, "create-disabled-1");
    const replay = await service.create(owner, target.id, input, "create-disabled-1");

    expect(first).toMatchObject({ enabled: false });
    expect(replay).toEqual(first);
    expect(scheduler.registerAll).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(await listRoutines(db())).toHaveLength(1);
    expect(await listControlAuditEvents(db(), { targetId: first.id, limit: 100 })).toMatchObject({
      items: [expect.objectContaining({ action: "routine.create", outcome: "succeeded" })],
    });
    expect(
      (await db().query.controlOperations.findMany()).filter((operation) => operation.targetId === first.id),
    ).toHaveLength(1);
  });

  it("registers and starts an enabled routine created through the service", async () => {
    const target = await persona("Scheduled");
    const scheduler = schedulerFake();
    const service = new RoutineService(db(), scheduler);

    const created = await service.create(
      { kind: "owner", source: "rest" },
      target.id,
      { name: "Enabled", cronSchedule: "0 8 * * *", promptTemplate: "Run", enabled: true },
      "create-enabled-1",
    );

    expect(created).toMatchObject({ enabled: true });
    expect(scheduler.registerAll).toHaveBeenCalledWith([created]);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
  });

  it("commits the mutation, records a retryable scheduler reconciliation failure, and rebuilds from committed routines", async () => {
    const target = await persona("Target");
    const scheduler = schedulerFake({
      reschedule: vi.fn(() => {
        throw new Error("scheduler unavailable");
      }),
    });
    const service = new RoutineService(db(), scheduler);
    const owner = { kind: "owner", source: "rest" } as const;
    const routine = await createRoutine(db(), {
      personaId: target.id,
      name: "Routine",
      cronSchedule: "0 8 * * *",
      promptTemplate: "Prompt",
    });

    await expect(service.update(owner, routine.id, { name: "Committed" }, "update-1")).rejects.toMatchObject({
      category: "scheduler_reconciliation_pending",
      retryable: true,
    });

    expect((await getRoutine(db(), routine.id))?.name).toBe("Committed");
    expect(scheduler.replaceAll).toHaveBeenCalledWith(await listRoutines(db()));
    const audits = await listControlAuditEvents(db(), { targetId: routine.id, limit: 100 });
    expect(audits.items[0]).toMatchObject({
      action: "routine.update",
      outcome: "pending",
      errorCategory: "scheduler_reconciliation_pending",
    });

    await expect(service.update(owner, routine.id, { name: "Committed" }, "update-1")).resolves.toMatchObject({
      id: routine.id,
      name: "Committed",
    });
    expect(scheduler.reschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(2);
    expect((await listControlAuditEvents(db(), { targetId: routine.id, limit: 100 })).items[0]).toMatchObject({
      outcome: "succeeded",
      errorCategory: null,
    });
    expect((await db().query.controlOperations.findMany())[0]).toMatchObject({
      status: "completed",
      errorCategory: null,
      result: expect.objectContaining({ routine: expect.objectContaining({ id: routine.id }) }),
    });
  });

  it("retries a pending delete reconciliation after the routine row is gone", async () => {
    const target = await persona("Target");
    const scheduler = schedulerFake({
      unschedule: vi.fn(() => {
        throw new Error("scheduler unavailable");
      }),
      replaceAll: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("scheduler still unavailable");
        })
        .mockImplementationOnce(() => {}),
    });
    const service = new RoutineService(db(), scheduler);
    const owner = { kind: "owner", source: "rest" } as const;
    const routine = await createRoutine(db(), {
      personaId: target.id,
      name: "Routine",
      cronSchedule: "0 8 * * *",
      promptTemplate: "Prompt",
    });

    await expect(service.delete(owner, routine.id, "delete-1")).rejects.toMatchObject({
      category: "scheduler_reconciliation_pending",
      retryable: true,
    });
    expect(await getRoutine(db(), routine.id)).toBeUndefined();

    await expect(service.delete(owner, routine.id, "delete-1")).resolves.toBeUndefined();
    expect(scheduler.unschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(2);
    expect((await listControlAuditEvents(db(), { targetId: routine.id, limit: 100 })).items[0]).toMatchObject({
      action: "routine.delete",
      outcome: "succeeded",
      errorCategory: null,
    });
  });
});
