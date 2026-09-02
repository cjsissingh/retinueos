import cron, { type ScheduledTask } from "node-cron";
import { randomUUID } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { DrizzleDb } from "../db/client.js";
import type { RoutineRow } from "../db/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createQueuedJob } from "../jobs/job-attempt-repo.js";
import { getPersona } from "../personas/persona-repo.js";
import { getRoutine, updateRoutineFired } from "../personas/routine-repo.js";
import { generateDigest } from "../notifications/digest-generator.js";
import { JobEventBus, defaultJobEventBus } from "./event-bus.js";

/**
 * The subset of PersonaScheduler that routes depend on. Consumers (and test
 * doubles) should type against this rather than the concrete class, so a
 * fake scheduler is a plain object literal instead of a cast through
 * `unknown`.
 */
export interface SchedulerHandle {
  registerAll(routines: RoutineRow[]): void;
  replaceAll(routines: RoutineRow[]): void;
  start(): void;
  unschedule(routineId: string): void;
  reschedule(routine: RoutineRow): void;
  runNow(routineId: string): Promise<void>;
}

/**
 * One node-cron job per routine, not per persona — a persona can run
 * several distinct named routines (a Morning Digest, an Inbox Sweep, a
 * Fitness Check), each on its own schedule with its own prompt, rather than
 * firing the same canned check-in message regardless of what it's supposed
 * to accomplish.
 */
export class PersonaScheduler implements SchedulerHandle {
  private tasks = new Map<string, ScheduledTask>();
  private inFlight = new Set<Promise<void>>();
  private started = false;

  constructor(
    private db: DrizzleDb,
    _registry?: ToolRegistry,
    _checkpointer?: BaseCheckpointSaver,
    _bus: JobEventBus = defaultJobEventBus,
  ) {}

  registerAll(routines: RoutineRow[]): void {
    for (const routine of routines) {
      // A disabled routine gets no cron task at all -- not a task that's
      // registered but never started. That keeps "is this routine
      // scheduled" answerable by "is it in this.tasks", which unschedule
      // and reschedule below both rely on.
      if (!routine.enabled) continue;
      try {
        const task = cron.createTask(routine.cronSchedule, () => {
          const firing = this.runNow(routine.id)
            .catch((error) => {
              console.error(`PersonaScheduler: failed to enqueue routine ${routine.id}:`, error);
            })
            .finally(() => this.inFlight.delete(firing));
          this.inFlight.add(firing);
        });
        this.tasks.set(routine.id, task);
        if (this.started) task.start();
      } catch (err) {
        // Defense in depth: RoutineCreateSchema validates cronSchedule at
        // creation time, but a row could predate that validation. An
        // invalid expression here must not throw and abort registerAll —
        // that would crash the process on every startup (a permanent boot
        // loop), so skip this routine's schedule and keep going.
        console.error(
          `PersonaScheduler: invalid cronSchedule "${routine.cronSchedule}" for routine ${routine.id}, skipping:`,
          err,
        );
      }
    }
  }

  replaceAll(routines: RoutineRow[]): void {
    this.stop();
    this.registerAll(routines);
    this.start();
  }

  /**
   * Enqueues one immediate run of a routine, exactly the way its own cron
   * tick would — the "run now" button's backend, and (via the cron
   * callback in registerAll) what a real tick actually calls. Runs a
   * disabled routine too: a manual run-now is an explicit user action, not
   * the schedule firing on its own, so `enabled` (which only gates whether
   * this routine *has* a live cron task at all) doesn't apply here.
   *
   * Branches on `routine.kind`: a "job" routine (the default, and every
   * routine that predates this column) seeds a normal chat job the same way
   * it always has. A "digest" routine has no chat turn to seed at all —
   * it calls generateDigest directly, which writes its own `digests` row
   * and (unless push:false) writes a routine_ran notification, so no `jobs` row
   * is created for it. Either way, updateRoutineFired still runs: a digest
   * routine's fire history matters exactly as much as a job routine's.
   */
  async runNow(routineId: string): Promise<void> {
    const routine = await getRoutine(this.db, routineId);
    if (!routine) return;
    const persona = await getPersona(this.db, routine.personaId);
    if (!persona) return;
    if (routine.kind === "digest") {
      await generateDigest(this.db, persona.id, { routineId: routine.id, push: routine.notifyRoutineRan });
    } else {
      await createQueuedJob(this.db, {
        personaId: persona.id,
        routineId: routine.id,
        depth: 0,
        origin: "cron",
        prompt: routine.promptTemplate,
        notifyOnOutcome: routine.notifyRoutineRan,
        langgraphThreadId: randomUUID(),
      });
    }
    await updateRoutineFired(this.db, routine.id);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks.values()) task.start();
  }

  stop(): void {
    this.started = false;
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.inFlight);
  }

  /**
   * Stops and forgets one routine's cron task — the counterpart to
   * registerAll's per-routine scheduling, needed because deleting a routine
   * (routine-routes.ts's DELETE /routines/:id) has no other way to reach
   * this in-memory scheduler. Without it, a deleted routine's task keeps
   * ticking forever: runNow re-fetches the routine every time and no-ops
   * once it's gone, so nothing user-visible breaks, but the task itself —
   * and its node-cron timer — is never released, a small permanent leak per
   * deleted routine for the life of the process. A no-op if this routine
   * was never registered (nothing to stop).
   */
  unschedule(routineId: string): void {
    const task = this.tasks.get(routineId);
    if (!task) return;
    task.stop();
    this.tasks.delete(routineId);
  }

  /**
   * Applies an update to one routine's live schedule — routine-routes.ts's
   * PATCH /routines/:id, after the row itself is already updated in the
   * database. Unconditionally unschedule-then-registerAll rather than
   * trying to mutate the existing node-cron task in place: node-cron has no
   * "change this task's expression" API, and registerAll already contains
   * the one correct set of rules for whether a routine gets a task at all
   * (registerAll's `enabled` check) — duplicating that logic here would be
   * one more place to keep in sync with it.
   */
  reschedule(routine: RoutineRow): void {
    this.unschedule(routine.id);
    this.registerAll([routine]);
  }
}
