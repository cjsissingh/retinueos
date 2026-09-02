import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { DrizzleDb } from "../db/client.js";
import type { JobRow } from "../db/schema.js";
import {
  abandonExpiredAttempts,
  applyAttemptEffects,
  assertLiveAttempt,
  beginExternalAttemptEffect,
  completeExternalAttemptEffect,
  claimNextAttempt,
  createClaimedChild,
  heartbeatAttemptControl,
  releaseUnstartedAttempt,
  requestJobCancellation,
  settleAttempt,
  type ClaimedExecution,
  type CompletedExternalEffect,
  type AttemptOutcome,
  type AppliedAttemptEffects,
  type DelegatedChildInput,
  type InFlightAttemptEffect,
  type SettledAttempt,
  type WorkerId,
  type JobCancellationResult,
  DEFAULT_ABORT_GRACE_MS,
  DEFAULT_EXECUTION_TIMEOUT_MS,
} from "../jobs/job-attempt-repo.js";
import { getJob } from "../jobs/job-repo.js";
import { deliverNotification, releaseHeldApprovalPush } from "../notifications/notify.js";
import type { ToolRegistry } from "../tools/registry.js";
import { executeClaimedExecution, publishCommittedOutcomeEvents } from "./dispatcher.js";
import { JobEventBus, defaultJobEventBus } from "./event-bus.js";
import { broadcastPendingApprovals } from "./pending-approval-bus.js";
import { broadcastNotifications } from "./notification-bus.js";

export interface JobWorkerOptions {
  db: DrizzleDb;
  registry: ToolRegistry;
  checkpointer?: BaseCheckpointSaver;
  bus?: JobEventBus;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  recoveryIntervalMs?: number;
  executionTimeoutMs?: number;
  abortGraceMs?: number;
  processId?: string;
  execute?: JobAttemptExecutor;
}

interface JobExecutionContext {
  signal: AbortSignal;
  assertLive(): Promise<void>;
  beginExternalEffect(callId: string): Promise<void>;
  applyEffects(effects: readonly InFlightAttemptEffect[]): Promise<AppliedAttemptEffects>;
  executeDelegatedChild(input: DelegatedChildInput): Promise<JobRow>;
}

export type JobAttemptExecutor = (execution: ClaimedExecution, context: JobExecutionContext) => Promise<AttemptOutcome>;

class LeaseLostError extends Error {}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isCompletedExternalEffect(effect: InFlightAttemptEffect | undefined): effect is CompletedExternalEffect {
  return effect?.type === "record_tool_result" && effect.externalEffectCompleted === true;
}

class AttemptAbortError extends Error {
  constructor(readonly cancelReason: "user" | "deadline") {
    super(cancelReason === "deadline" ? "execution deadline exceeded" : "job cancelled");
  }
}

/**
 * Polling executor for durable job attempts. stop() prevents new claims and
 * wakes polling loops; drain() waits for every already-claimed execution.
 */
export class JobWorker {
  private readonly db: DrizzleDb;
  private readonly registry: ToolRegistry;
  private readonly checkpointer: BaseCheckpointSaver | undefined;
  private readonly bus: JobEventBus;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly executionTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly processId: string;
  private readonly execute: JobAttemptExecutor;
  private accepting = false;
  private runOnceInFlight = false;
  private loops: Promise<void>[] = [];
  private active = new Set<Promise<unknown>>();
  private wakeWaiters = new Set<() => void>();
  private controllers = new Map<string, AbortController>();

  constructor(options: JobWorkerOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.checkpointer = options.checkpointer;
    this.bus = options.bus ?? defaultJobEventBus;
    this.concurrency = positiveInteger("concurrency", options.concurrency ?? 2);
    this.pollIntervalMs = positiveInteger("poll interval", options.pollIntervalMs ?? 250);
    this.leaseDurationMs = positiveInteger("lease duration", options.leaseDurationMs ?? 30_000);
    this.heartbeatIntervalMs = positiveInteger("heartbeat interval", options.heartbeatIntervalMs ?? 10_000);
    this.recoveryIntervalMs = positiveInteger("recovery interval", options.recoveryIntervalMs ?? 30_000);
    this.executionTimeoutMs = positiveInteger(
      "execution timeout",
      options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    );
    this.abortGraceMs = positiveInteger("abort grace", options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("heartbeat interval must be shorter than lease duration");
    }
    if (this.abortGraceMs <= this.heartbeatIntervalMs) {
      throw new Error("abort grace must be longer than heartbeat interval");
    }
    this.processId = options.processId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    this.execute =
      options.execute ??
      ((execution, context) =>
        executeClaimedExecution(
          this.db,
          execution,
          this.registry,
          this.checkpointer,
          this.bus,
          context.signal,
          context.assertLive,
          context.beginExternalEffect,
          context.applyEffects,
          context.executeDelegatedChild,
        ));
  }

  workerIdForSlot(slot: number): WorkerId {
    return `${this.processId}:slot-${slot}`;
  }

  /** Best-effort local wakeup after the durable cancellation commits. */
  abortAttempt(attemptId: string): void {
    this.controllers.get(attemptId)?.abort(new AttemptAbortError("user"));
  }

  start(): void {
    if (this.accepting) return;
    if (this.runOnceInFlight || this.loops.length > 0) {
      throw new Error("worker must finish its current run or drain before it can start");
    }
    this.accepting = true;
    this.loops = Array.from({ length: this.concurrency }, (_, slot) => this.slotLoop(slot));
    this.loops.push(this.recoveryLoop());
  }

  stop(): void {
    this.accepting = false;
    for (const wake of this.wakeWaiters) wake();
    this.wakeWaiters.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.loops);
    await Promise.allSettled(this.active);
    this.loops = [];
  }

  /** Claims and completes at most `concurrency` currently queued attempts. */
  async runOnce(): Promise<number> {
    if (this.accepting || this.runOnceInFlight) throw new Error("worker is already running");
    this.runOnceInFlight = true;
    try {
      const claims = await Promise.all(
        Array.from({ length: this.concurrency }, (_, slot) =>
          claimNextAttempt(
            this.db,
            this.workerIdForSlot(slot),
            this.leaseDurationMs,
            undefined,
            this.executionTimeoutMs,
          ),
        ),
      );
      await Promise.all(
        claims.map((execution, slot) =>
          execution ? this.track(this.runClaimed(execution, this.workerIdForSlot(slot))) : Promise.resolve(),
        ),
      );
      return claims.filter(Boolean).length;
    } finally {
      this.runOnceInFlight = false;
    }
  }

  async recoverOnce(): Promise<number> {
    const abandoned = await abandonExpiredAttempts(this.db);
    for (const attempt of abandoned) {
      for (const notification of attempt.notifications) {
        await deliverNotification(this.db, notification);
      }
      if (attempt.notifications.length > 0) await broadcastNotifications(this.db);
      const job = await getJob(this.db, attempt.jobId);
      if (job) this.bus.publish(job.id, { type: "status", status: job.status });
    }
    await releaseHeldApprovalPush(this.db);
    return abandoned.length;
  }

  private async slotLoop(slot: number): Promise<void> {
    const workerId = this.workerIdForSlot(slot);
    while (this.accepting) {
      const execution = await claimNextAttempt(
        this.db,
        workerId,
        this.leaseDurationMs,
        undefined,
        this.executionTimeoutMs,
      ).catch((error) => {
        console.error(`JobWorker ${workerId} failed to claim:`, error);
        return undefined;
      });
      if (!execution) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      if (!this.accepting) {
        const released = await releaseUnstartedAttempt(this.db, execution.attempt.id, workerId).catch((error) => {
          console.error(`JobWorker ${workerId} failed to release an unstarted claim:`, error);
          return false;
        });
        if (!released) {
          console.error(
            `JobWorker ${workerId} stopped after claiming attempt ${execution.attempt.id}; it was not executed and recovery must reconcile it`,
          );
        }
        break;
      }
      await this.track(this.runClaimed(execution, workerId)).catch((error) => {
        console.error(`JobWorker ${workerId} execution failed:`, error);
      });
    }
  }

  private async recoveryLoop(): Promise<void> {
    while (this.accepting) {
      await this.recoverExpired();
      await this.wait(this.recoveryIntervalMs);
    }
  }

  private async recoverExpired(): Promise<void> {
    await this.recoverOnce().catch((error) => {
      console.error("JobWorker expired-attempt recovery failed:", error);
    });
  }

  private async runClaimed(
    execution: ClaimedExecution,
    workerId: WorkerId,
    propagate = false,
    parentSignal?: AbortSignal,
  ): Promise<JobRow> {
    this.bus.publish(execution.job.id, { type: "status", status: "running" });
    const controller = new AbortController();
    this.controllers.set(execution.attempt.id, controller);
    let heartbeatInFlight: Promise<void> | undefined;
    let leaseLost = false;
    let parentCancellationInFlight: Promise<JobCancellationResult | undefined> | undefined;
    const cascadeParentCancellation = () => {
      const reason =
        parentSignal?.reason instanceof AttemptAbortError ? parentSignal.reason.cancelReason : ("user" as const);
      parentCancellationInFlight ??= requestJobCancellation(
        this.db,
        execution.job.id,
        this.abortGraceMs,
        undefined,
        reason,
      )
        .then((result) => {
          if (result?.accepted) controller.abort(new AttemptAbortError(reason));
          return result;
        })
        .catch((error) => {
          leaseLost = true;
          controller.abort(new LeaseLostError(`failed to cascade cancellation to attempt ${execution.attempt.id}`));
          console.error(`JobWorker failed to cascade cancellation to attempt ${execution.attempt.id}:`, error);
          return undefined;
        });
    };
    if (parentSignal?.aborted) cascadeParentCancellation();
    else parentSignal?.addEventListener("abort", cascadeParentCancellation, { once: true });
    const pollControl = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = heartbeatAttemptControl(
        this.db,
        execution.attempt.id,
        workerId,
        this.leaseDurationMs,
        this.abortGraceMs,
      )
        .then((control) => {
          if (control.abort) {
            // Abort grace may already have expired while a nested child was
            // winding down. Keep settlement so the owner can commit cancelled
            // instead of reporting lease loss; recovery skip-locks this row.
            controller.abort(new AttemptAbortError(control.abort.reason));
            return;
          }
          if (!control.live) {
            leaseLost = true;
            controller.abort(new LeaseLostError(`attempt ${execution.attempt.id} lost its worker lease`));
          }
        })
        .catch((error) => {
          leaseLost = true;
          controller.abort(new LeaseLostError(`attempt ${execution.attempt.id} heartbeat failed`));
          console.error(`JobWorker heartbeat failed for attempt ${execution.attempt.id}:`, error);
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    };
    const heartbeatTimer = setInterval(pollControl, this.heartbeatIntervalMs);
    const deadlineDelay = Math.max(0, execution.attempt.deadlineAt!.getTime() - Date.now());
    const deadlineTimer = setTimeout(pollControl, deadlineDelay);

    const assertLive = async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (leaseLost || !(await assertLiveAttempt(this.db, execution.attempt.id, workerId))) {
        leaseLost = true;
        throw new LeaseLostError(`attempt ${execution.attempt.id} lost its worker lease`);
      }
    };

    let outcome: AttemptOutcome;
    let executionError: unknown;
    try {
      outcome = await this.execute(execution, {
        signal: controller.signal,
        assertLive,
        beginExternalEffect: async (callId) => {
          const marked = await beginExternalAttemptEffect(
            this.db,
            { attemptId: execution.attempt.id, workerId, leaseDurationMs: this.leaseDurationMs },
            callId,
          );
          if (!marked) {
            throw new LeaseLostError(`attempt ${execution.attempt.id} could not fence external call ${callId}`);
          }
        },
        applyEffects: async (effects) => {
          const lease = {
            attemptId: execution.attempt.id,
            workerId,
            leaseDurationMs: this.leaseDurationMs,
          };
          const externalCompletion =
            effects.length === 1 && isCompletedExternalEffect(effects[0]) ? effects[0] : undefined;
          const applied = externalCompletion
            ? await completeExternalAttemptEffect(this.db, lease, externalCompletion)
            : await applyAttemptEffects(this.db, lease, effects);
          if (!applied) {
            leaseLost = true;
            throw new LeaseLostError(`attempt ${execution.attempt.id} lost its worker lease before committing effects`);
          }
          return applied;
        },
        executeDelegatedChild: async (input) => this.executeChild(execution, input, workerId, controller.signal),
      });
    } catch (error) {
      executionError = error;
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener("abort", cascadeParentCancellation);
      await heartbeatInFlight;
      await parentCancellationInFlight;
      this.controllers.delete(execution.attempt.id);
    }

    let settled: SettledAttempt | undefined;
    if (!leaseLost) {
      try {
        settled = await settleAttempt(this.db, execution.attempt.id, workerId, outcome);
      } catch (error) {
        console.error(`JobWorker settlement failed for attempt ${execution.attempt.id}:`, error);
        throw error;
      }
    }
    if (!settled) {
      throw new LeaseLostError(
        `attempt ${execution.attempt.id} finished locally but lost its lease before settlement; outcome is unknown`,
      );
    }
    // Cancellation/deadline settlement can intentionally discard a locally
    // produced transcript/tool effect. Never stream an event for state that
    // did not commit.
    if (settled.status === outcome.status) publishCommittedOutcomeEvents(this.bus, execution.job.id, outcome);
    this.bus.publish(execution.job.id, { type: "status", status: settled.status });
    // waiting_approval settlement inserts the pending_approval row;
    // cancellation settlement can clear one. Either way the workspace
    // snapshot needs a fresh read after the transaction commits.
    await broadcastPendingApprovals(this.db);
    for (const notification of settled.applied.notifications) {
      await deliverNotification(this.db, notification);
    }
    if (settled.applied.notifications.length > 0) await broadcastNotifications(this.db);

    const job = await getJob(this.db, execution.job.id);
    if (!job) throw new Error(`job ${execution.job.id} disappeared after attempt execution`);
    if (propagate && executionError) throw executionError;
    return job;
  }

  private async executeChild(
    parent: ClaimedExecution,
    input: DelegatedChildInput,
    workerId: WorkerId,
    parentSignal: AbortSignal,
  ): Promise<JobRow> {
    const claimed = await createClaimedChild(
      this.db,
      {
        attemptId: parent.attempt.id,
        workerId,
        leaseDurationMs: this.leaseDurationMs,
        executionTimeoutMs: this.executionTimeoutMs,
      },
      input,
    );
    if (!claimed) throw new LeaseLostError(`parent attempt ${parent.attempt.id} lost its lease before child creation`);
    return this.runClaimed(claimed, workerId, true, parentSignal);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => this.active.delete(tracked));
    this.active.add(tracked);
    return tracked;
  }

  private wait(ms: number): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        this.wakeWaiters.delete(wake);
        resolve();
      };
      const wake = () => {
        clearTimeout(timer);
        done();
      };
      timer = setTimeout(done, ms);
      this.wakeWaiters.add(wake);
    });
  }
}
