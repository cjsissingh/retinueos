import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, isNull, lte, max, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import {
  jobAttempts,
  jobs,
  notifications,
  personas,
  personaMemories,
  personaState,
  routines,
  toolCalls,
  type JobAttemptRow,
  type JobRow,
  type AttemptCancelReason,
  type JobStatus,
  type NotificationKind,
  type NotificationRow,
  type PersonaStateRow,
  type ToolCallRow,
} from "../db/schema.js";
import { createMessage } from "./message-repo.js";
import { outcomeNotificationMessage } from "../notifications/notify.js";
import { notificationTitle } from "../notifications/notification-repo.js";
import { isReservedMemoryLabel } from "../personas/persona-memory-repo.js";
import type { RiskClass } from "../tools/registry.js";

const DEFAULT_LEASE_DURATION_MS = 30_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_ABORT_GRACE_MS = 20_000;

/**
 * Opaque id for one live worker process incarnation. Include a startup-random
 * component, keep it stable for that process lifetime, and never reuse it for
 * a restarted process; reuse would share the prior incarnation's lease fence.
 */
export type WorkerId = string;

type DbTransaction = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

export interface QueuedExecution {
  job: JobRow;
  attempt: JobAttemptRow;
}

export interface ClaimedExecution extends QueuedExecution {
  attempt: JobAttemptRow & { status: "running"; workerId: WorkerId; leaseExpiresAt: Date };
}

export interface RecoveredAttempt extends JobAttemptRow {
  notifications: NotificationRow[];
}

export interface CreateQueuedJobInput {
  personaId: string;
  parentJobId?: string | null;
  routineId?: string | null;
  depth: number;
  origin: "cron" | "user" | "delegation";
  prompt: string;
  langgraphThreadId: string;
  messageAt?: Date;
  notifyOnOutcome?: boolean;
}

export interface EnqueueContinuationOptions {
  at?: Date;
  notifyOnOutcome?: boolean;
}

export interface AttemptLease {
  attemptId: string;
  workerId: WorkerId;
  leaseDurationMs: number;
  executionTimeoutMs?: number;
}

export type InFlightAttemptEffect =
  | {
      type: "record_tool_result";
      callId: string;
      toolId: string;
      riskClass: RiskClass;
      arguments: Record<string, unknown>;
      result: Record<string, unknown>;
      status: "executed" | "failed";
      gated: boolean;
      externalEffectCompleted?: boolean;
    }
  | { type: "write_persona_state"; key: string; content: string }
  | { type: "delete_persona_state"; key: string }
  | {
      type: "remember_persona_memory";
      id: string;
      personaId: string;
      label: string;
      content: string;
      sourceJobId: string | null;
      sensitivity: "normal" | "sensitive";
      importance: 0 | 1 | 2;
    }
  | { type: "forget_persona_memory"; personaId: string; label: string };

export type WaitingApprovalEffect =
  | {
      type: "create_pending_tool_call";
      callId: string;
      toolId: string;
      riskClass: RiskClass;
      arguments: Record<string, unknown>;
    }
  | { type: "append_assistant_message"; content: string; at: Date };

export type CompletionEffect =
  | { type: "append_assistant_message"; content: string; at: Date }
  | { type: "set_persona_summary"; content: string }
  | { type: "set_routine_summary"; routineId: string; content: string }
  | { type: "insert_notification"; routineId?: string; message: string; urgent: boolean };

interface CommittedAttemptEvent {
  type: "model_end";
  content: string | null;
}

export type AttemptOutcome =
  | { status: "done"; effects?: readonly CompletionEffect[]; events?: readonly CommittedAttemptEvent[] }
  | {
      status: "waiting_approval";
      effects?: readonly WaitingApprovalEffect[];
      events?: readonly CommittedAttemptEvent[];
    }
  | { status: "failed"; error: string };

export interface AppliedAttemptEffects {
  toolCalls: ToolCallRow[];
  personaState: PersonaStateRow[];
  notifications: NotificationRow[];
}

export interface SettledAttempt extends JobAttemptRow {
  job: JobRow;
  applied: AppliedAttemptEffects;
}

export interface DelegatedChildInput {
  personaId: string;
  prompt: string;
  langgraphThreadId: string;
  messageAt?: Date;
}

class AttemptConflict extends Error {}

function requireLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("lease duration must be a positive integer number of milliseconds");
  }
}

function leaseExpiry(now: Date, leaseDurationMs: number): Date {
  requireLeaseDuration(leaseDurationMs);
  return new Date(now.getTime() + leaseDurationMs);
}

function futureTimestamp(now: Date, durationMs: number, name: string): Date {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error(`${name} must be a positive integer`);
  return new Date(now.getTime() + durationMs);
}

function requireWorkerId(workerId: WorkerId): void {
  if (!workerId.trim()) throw new Error("worker id must not be empty");
}

async function databaseClockTimestamp(tx: DbTransaction, injected?: Date): Promise<Date> {
  if (injected) return injected;
  // PostgreSQL now() is fixed at transaction start. Leases instead need wall
  // time sampled after their row locks have been acquired.
  const [row] = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  if (!row) throw new Error("database did not return its current time");
  // postgres-js returns raw execute() timestamptz values as strings even
  // though Drizzle maps typed timestamp columns to Date instances.
  return row.now instanceof Date ? row.now : new Date(row.now);
}

async function nextSequence(tx: DbTransaction, jobId: string): Promise<number> {
  const [row] = await tx
    .select({ value: max(jobAttempts.sequence) })
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId));
  return (row?.value ?? 0) + 1;
}

interface LockedLiveAttempt {
  attempt: JobAttemptRow & { workerId: WorkerId; leaseExpiresAt: Date };
  job: JobRow;
  checkedAt: Date;
}

async function lockLiveAttempt(
  tx: DbTransaction,
  attemptId: string,
  workerId: WorkerId,
  injectedNow?: Date,
  allowCancellation = false,
): Promise<LockedLiveAttempt> {
  const [attempt] = await tx
    .select()
    .from(jobAttempts)
    .where(and(eq(jobAttempts.id, attemptId), eq(jobAttempts.workerId, workerId), eq(jobAttempts.status, "running")))
    .for("update");
  if (!attempt?.workerId || !attempt.leaseExpiresAt) throw new AttemptConflict();

  const [job] = await tx.select().from(jobs).where(eq(jobs.id, attempt.jobId)).for("update");
  if (!job || (job.status !== "running" && !(allowCancellation && job.status === "cancelling"))) {
    throw new AttemptConflict();
  }

  const checkedAt = await databaseClockTimestamp(tx, injectedNow);
  const finishingRequestedCancel = allowCancellation && attempt.cancelRequestedAt !== null;
  if (attempt.leaseExpiresAt <= checkedAt && !finishingRequestedCancel) throw new AttemptConflict();
  if (
    !allowCancellation &&
    (attempt.cancelRequestedAt !== null || (attempt.deadlineAt !== null && attempt.deadlineAt <= checkedAt))
  ) {
    throw new AttemptConflict();
  }
  return {
    attempt: { ...attempt, workerId: attempt.workerId, leaseExpiresAt: attempt.leaseExpiresAt },
    job,
    checkedAt,
  };
}

function emptyAppliedEffects(): AppliedAttemptEffects {
  return { toolCalls: [], personaState: [], notifications: [] };
}

async function applyEffects(
  tx: DbTransaction,
  job: JobRow,
  attemptId: string,
  effects: readonly (InFlightAttemptEffect | WaitingApprovalEffect | CompletionEffect)[],
  effectAt: Date,
): Promise<AppliedAttemptEffects> {
  const applied = emptyAppliedEffects();
  for (const effect of effects) {
    switch (effect.type) {
      case "record_tool_result": {
        const [existing] = await tx
          .select()
          .from(toolCalls)
          .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.callId, effect.callId)))
          .for("update");
        if (existing) {
          const sameIdentity =
            existing.toolId === effect.toolId &&
            existing.riskClass === effect.riskClass &&
            isDeepStrictEqual(existing.arguments, effect.arguments);
          if (!sameIdentity) throw new Error(`tool audit identity changed for job ${job.id} call ${effect.callId}`);
          if (existing.status === "executed" || existing.status === "failed") {
            if (existing.status !== effect.status || !isDeepStrictEqual(existing.result, effect.result)) {
              throw new Error(`tool audit for job ${job.id} call ${effect.callId} is already terminal`);
            }
            applied.toolCalls.push(existing);
            break;
          }
          if (!effect.gated || existing.status !== "approved") {
            throw new Error(`tool audit for job ${job.id} call ${effect.callId} is ${existing.status}`);
          }
          const [completed] = await tx
            .update(toolCalls)
            .set({ status: effect.status, result: effect.result, jobAttemptId: attemptId })
            .where(and(eq(toolCalls.id, existing.id), eq(toolCalls.status, "approved")))
            .returning();
          if (!completed) throw new Error(`tool audit for job ${job.id} call ${effect.callId} changed state`);
          applied.toolCalls.push(completed);
          break;
        }
        if (effect.gated) throw new Error(`no approved tool audit exists for job ${job.id} call ${effect.callId}`);
        const [created] = await tx
          .insert(toolCalls)
          .values({
            jobId: job.id,
            jobAttemptId: attemptId,
            callId: effect.callId,
            toolId: effect.toolId,
            riskClass: effect.riskClass,
            arguments: effect.arguments,
            status: effect.status,
            result: effect.result,
          })
          .returning();
        applied.toolCalls.push(created);
        break;
      }
      case "write_persona_state": {
        const [state] = await tx
          .insert(personaState)
          .values({ personaId: job.personaId, key: effect.key, content: effect.content, updatedAt: effectAt })
          .onConflictDoUpdate({
            target: [personaState.personaId, personaState.key],
            set: { content: effect.content, updatedAt: effectAt },
          })
          .returning();
        applied.personaState.push(state);
        break;
      }
      case "delete_persona_state": {
        await tx
          .delete(personaState)
          .where(and(eq(personaState.personaId, job.personaId), eq(personaState.key, effect.key)));
        break;
      }
      case "remember_persona_memory": {
        if (isReservedMemoryLabel(effect.label)) {
          throw new Error('memory labels beginning with "job-summary:" are reserved for thread hygiene');
        }
        const [prior] = await tx
          .select({ id: personaMemories.id })
          .from(personaMemories)
          .where(
            and(
              eq(personaMemories.personaId, effect.personaId),
              eq(personaMemories.label, effect.label),
              isNull(personaMemories.supersededAt),
              or(isNull(personaMemories.expiresAt), gt(personaMemories.expiresAt, sql`now()`)),
            ),
          );
        if (prior) {
          await tx.update(personaMemories).set({ supersededAt: effectAt }).where(eq(personaMemories.id, prior.id));
        }
        await tx.insert(personaMemories).values({
          id: effect.id,
          personaId: effect.personaId,
          label: effect.label,
          content: effect.content,
          sourceJobId: effect.sourceJobId,
          supersedesId: prior?.id ?? null,
          sensitivity: effect.sensitivity,
          importance: effect.importance,
          createdAt: effectAt,
          updatedAt: effectAt,
        });
        break;
      }
      case "forget_persona_memory": {
        if (isReservedMemoryLabel(effect.label)) {
          throw new Error('memory labels beginning with "job-summary:" are reserved for thread hygiene');
        }
        await tx
          .delete(personaMemories)
          .where(
            and(
              eq(personaMemories.personaId, effect.personaId),
              eq(personaMemories.label, effect.label),
              isNull(personaMemories.supersededAt),
              or(isNull(personaMemories.expiresAt), gt(personaMemories.expiresAt, sql`now()`)),
            ),
          );
        break;
      }
      case "create_pending_tool_call": {
        const [existing] = await tx
          .select()
          .from(toolCalls)
          .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.callId, effect.callId)))
          .for("update");
        if (existing) {
          const sameIdentity =
            existing.toolId === effect.toolId &&
            existing.riskClass === effect.riskClass &&
            isDeepStrictEqual(existing.arguments, effect.arguments);
          if (!sameIdentity)
            throw new Error(`pending tool audit identity changed for job ${job.id} call ${effect.callId}`);
          if (existing.status !== "pending_approval") {
            throw new Error(`tool audit for job ${job.id} call ${effect.callId} is already ${existing.status}`);
          }
          applied.toolCalls.push(existing);
          break;
        }
        const [created] = await tx
          .insert(toolCalls)
          .values({
            jobId: job.id,
            jobAttemptId: attemptId,
            callId: effect.callId,
            toolId: effect.toolId,
            riskClass: effect.riskClass,
            arguments: effect.arguments,
          })
          .returning();
        applied.toolCalls.push(created);
        break;
      }
      case "append_assistant_message": {
        await createMessage(tx, job.id, "assistant", effect.content, effect.at);
        break;
      }
      case "set_persona_summary": {
        const [updated] = await tx
          .update(personas)
          .set({ lastSummary: effect.content })
          .where(eq(personas.id, job.personaId))
          .returning({ id: personas.id });
        if (!updated) throw new Error(`persona ${job.personaId} disappeared during attempt settlement`);
        break;
      }
      case "set_routine_summary": {
        // Deleting a routine clears jobs.routine_id while holding the job
        // lock. If deletion won that race, suppress bookkeeping derived from
        // the dispatcher's older routine snapshot and still settle the job.
        if (job.routineId !== effect.routineId) break;
        const [updated] = await tx
          .update(routines)
          .set({ lastSummary: effect.content, lastFiredAt: effectAt })
          .where(eq(routines.id, effect.routineId))
          .returning({ id: routines.id });
        if (!updated) throw new Error(`routine ${effect.routineId} disappeared during attempt settlement`);
        break;
      }
      case "insert_notification": {
        // A direct notification carrying routine identity is routine-owned.
        // Suppress it when deletion won the job-lock race. Notifications not
        // tied to a routine retain their existing behavior.
        if (effect.routineId !== undefined && job.routineId !== effect.routineId) break;
        const [notification] = await tx
          .insert(notifications)
          .values({
            personaId: job.personaId,
            jobId: job.id,
            kind: "job_finished",
            title: notificationTitle("job_finished"),
            message: effect.message,
            urgent: effect.urgent,
            delivered: false,
          })
          .returning();
        applied.notifications.push(notification);
        break;
      }
    }
  }
  return applied;
}

export async function createQueuedJob(db: DrizzleDb, input: CreateQueuedJobInput): Promise<QueuedExecution> {
  return db.transaction(async (tx) => {
    const at = input.messageAt ?? new Date();
    const [job] = await tx
      .insert(jobs)
      .values({
        personaId: input.personaId,
        parentJobId: input.parentJobId ?? null,
        routineId: input.routineId ?? null,
        depth: input.depth,
        origin: input.origin,
        prompt: input.prompt,
        langgraphThreadId: input.langgraphThreadId,
        status: "queued",
      })
      .returning();
    await createMessage(tx, job.id, "user", input.prompt, at);
    const [attempt] = await tx
      .insert(jobAttempts)
      .values({
        jobId: job.id,
        sequence: 1,
        input: { type: "user_message", content: input.prompt },
        notifyOnOutcome: input.notifyOnOutcome ?? false,
      })
      .returning();
    return { job, attempt };
  });
}

/**
 * Creates a delegated child already claimed by the parent worker while the
 * parent's live lease is locked. No queued child is ever visible to another
 * polling slot, and a stale parent cannot enqueue durable work.
 */
export async function createClaimedChild(
  db: DrizzleDb,
  parentLease: AttemptLease,
  input: DelegatedChildInput,
  injectedNow?: Date,
  injectedFinalNow?: Date,
): Promise<ClaimedExecution | undefined> {
  requireWorkerId(parentLease.workerId);
  requireLeaseDuration(parentLease.leaseDurationMs);
  try {
    return await db.transaction(async (tx) => {
      const parent = await lockLiveAttempt(tx, parentLease.attemptId, parentLease.workerId, injectedNow);
      const messageAt = input.messageAt ?? parent.checkedAt;
      const [childJob] = await tx
        .insert(jobs)
        .values({
          personaId: input.personaId,
          parentJobId: parent.job.id,
          depth: parent.job.depth + 1,
          origin: "delegation",
          prompt: input.prompt,
          langgraphThreadId: input.langgraphThreadId,
          status: "running",
          updatedAt: parent.checkedAt,
        })
        .returning();
      await createMessage(tx, childJob.id, "user", input.prompt, messageAt);

      const initialExpiry = leaseExpiry(parent.checkedAt, parentLease.leaseDurationMs);
      const deadlineAt = futureTimestamp(
        parent.checkedAt,
        parentLease.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        "execution timeout",
      );
      const [childAttempt] = await tx
        .insert(jobAttempts)
        .values({
          jobId: childJob.id,
          sequence: 1,
          input: { type: "user_message", content: input.prompt },
          status: "running",
          workerId: parentLease.workerId,
          startedAt: parent.checkedAt,
          lastHeartbeatAt: parent.checkedAt,
          leaseExpiresAt: initialExpiry,
          deadlineAt,
        })
        .returning();

      // Both leases are refreshed only after every potentially blocking child
      // insert. Recovery cannot acquire the locked parent attempt between this
      // final validation and commit.
      const renewedAt = await databaseClockTimestamp(tx, injectedFinalNow ?? injectedNow);
      if (parent.attempt.leaseExpiresAt <= renewedAt) throw new AttemptConflict();
      const expiresAt = leaseExpiry(renewedAt, parentLease.leaseDurationMs);
      const renewed = await tx
        .update(jobAttempts)
        .set({ lastHeartbeatAt: renewedAt, leaseExpiresAt: expiresAt })
        .where(
          and(
            or(eq(jobAttempts.id, parent.attempt.id), eq(jobAttempts.id, childAttempt.id)),
            eq(jobAttempts.workerId, parentLease.workerId),
            eq(jobAttempts.status, "running"),
          ),
        )
        .returning({ id: jobAttempts.id });
      if (renewed.length !== 2) throw new AttemptConflict();
      return {
        job: childJob,
        attempt: {
          ...childAttempt,
          status: "running",
          workerId: parentLease.workerId,
          leaseExpiresAt: expiresAt,
        },
      };
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export async function enqueueContinuation(
  db: DrizzleDb,
  jobId: string,
  content: string,
  options: EnqueueContinuationOptions = {},
): Promise<QueuedExecution | undefined> {
  const at = options.at ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      // Queue producers lock the terminal aggregate before inserting a new
      // attempt. Claim/settle/recovery lock the active attempt before its
      // running aggregate. Those state sets do not overlap, which keeps this
      // exception to the attempt-then-job lock order from forming a cycle.
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (!job || (job.status !== "done" && job.status !== "failed")) throw new AttemptConflict();

      const [latest] = await tx
        .select({ status: jobAttempts.status })
        .from(jobAttempts)
        .where(eq(jobAttempts.jobId, jobId))
        .orderBy(desc(jobAttempts.sequence))
        .limit(1);
      if (latest && ["queued", "running", "abandoned"].includes(latest.status)) throw new AttemptConflict();

      const sequence = await nextSequence(tx, jobId);
      const [attempt] = await tx
        .insert(jobAttempts)
        .values({
          jobId,
          sequence,
          input: { type: "user_message", content },
          notifyOnOutcome: options.notifyOnOutcome ?? false,
        })
        .returning();
      await createMessage(tx, jobId, "user", content, at);
      const [queued] = await tx
        .update(jobs)
        .set({ status: "queued", error: null, updatedAt: at })
        .where(and(eq(jobs.id, jobId), or(eq(jobs.status, "done"), eq(jobs.status, "failed"))))
        .returning();
      if (!queued) throw new AttemptConflict();
      return { job: queued, attempt };
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export async function enqueueRetry(db: DrizzleDb, jobId: string): Promise<QueuedExecution | undefined> {
  try {
    return await db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (!job || !RETRYABLE_JOB_STATUSES.includes(job.status)) throw new AttemptConflict();

      const [lastAttempt] = await tx
        .select()
        .from(jobAttempts)
        .where(eq(jobAttempts.jobId, jobId))
        .orderBy(desc(jobAttempts.sequence))
        .limit(1)
        .for("update");
      if (!lastAttempt) throw new AttemptConflict();

      // Legacy pre-migration-0023 rows have jobAttemptId: null and are otherwise
      // invisible to this attribution check. Include them to fail closed rather
      // than silently treating an unattributed destructive-tool row as absent.
      const lastAttemptToolCalls = await tx
        .select()
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.jobId, jobId),
            or(eq(toolCalls.jobAttemptId, lastAttempt.id), isNull(toolCalls.jobAttemptId)),
          ),
        );
      if (!evaluateRetryEligibility(job, lastAttempt, lastAttemptToolCalls).eligible) throw new AttemptConflict();

      const sequence = await nextSequence(tx, jobId);
      const [attempt] = await tx
        .insert(jobAttempts)
        .values({
          jobId,
          sequence,
          input: { type: "retry" },
          notifyOnOutcome: lastAttempt.notifyOnOutcome,
        })
        .returning();
      const [queued] = await tx
        .update(jobs)
        .set({ status: "queued", error: null })
        .where(and(eq(jobs.id, jobId), sql`${jobs.status} in ('failed', 'cancelled', 'timed_out')`))
        .returning();
      if (!queued) throw new AttemptConflict();
      return { job: queued, attempt };
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export interface ApprovalResumeExecution extends QueuedExecution {
  toolCall: ToolCallRow;
}

/**
 * Runs inside the existing approval-resume transaction after the job, tool
 * call, and attempt changes have been prepared but before they commit.
 */
export type ApprovalResumeSettlement = (
  tx: Pick<DrizzleDb, "insert" | "select" | "update">,
  execution: ApprovalResumeExecution,
) => Promise<void>;

/** Runs after the legacy job -> tool locks and before any approval mutation. */
export type ApprovalResumePreparation = (tx: Pick<DrizzleDb, "insert" | "select" | "update">) => Promise<void>;

export async function enqueueApprovalResume(
  db: DrizzleDb,
  toolCallId: string,
  approved: boolean,
  settle?: ApprovalResumeSettlement,
  prepare?: ApprovalResumePreparation,
): Promise<ApprovalResumeExecution | undefined> {
  try {
    return await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(toolCalls)
        .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.status, "pending_approval")));
      if (!candidate) throw new AttemptConflict();

      // Match the legacy approval path's job -> tool lock order so rolling
      // deployments cannot deadlock old and new approval handlers. A waiting
      // aggregate cannot have a claimable attempt.
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, candidate.jobId)).for("update");
      if (!job || job.status !== "waiting_approval") throw new AttemptConflict();

      const [pending] = await tx
        .select()
        .from(toolCalls)
        .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.jobId, job.id), eq(toolCalls.status, "pending_approval")))
        .for("update");
      if (!pending) throw new AttemptConflict();

      await prepare?.(tx);

      const [pausedAttempt] = await tx
        .select({ notifyOnOutcome: jobAttempts.notifyOnOutcome })
        .from(jobAttempts)
        .where(and(eq(jobAttempts.jobId, job.id), eq(jobAttempts.status, "waiting_approval")))
        .orderBy(desc(jobAttempts.sequence))
        .limit(1);

      const sequence = await nextSequence(tx, job.id);
      const [attempt] = await tx
        .insert(jobAttempts)
        .values({
          jobId: job.id,
          sequence,
          input: { type: "approval_resume", toolCallId, approved },
          notifyOnOutcome: pausedAttempt?.notifyOnOutcome ?? false,
        })
        .returning();
      const [toolCall] = await tx
        .update(toolCalls)
        .set({ status: approved ? "approved" : "rejected" })
        .where(and(eq(toolCalls.id, toolCallId), eq(toolCalls.status, "pending_approval")))
        .returning();
      if (!toolCall) throw new AttemptConflict();
      const [queued] = await tx
        .update(jobs)
        .set({ status: "queued", error: null, updatedAt: new Date() })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "waiting_approval")))
        .returning();
      if (!queued) throw new AttemptConflict();
      const execution = { job: queued, attempt, toolCall };
      await settle?.(tx, execution);
      return execution;
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

async function claimLockedAttempt(
  tx: DbTransaction,
  attempt: JobAttemptRow,
  workerId: WorkerId,
  leaseDurationMs: number,
  injectedNow?: Date,
  executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
): Promise<ClaimedExecution> {
  // Active attempt operations always lock attempt -> aggregate. Acquire both
  // before sampling wall time so lock waits cannot consume the fresh lease.
  const [lockedJob] = await tx.select().from(jobs).where(eq(jobs.id, attempt.jobId)).for("update");
  if (!lockedJob || lockedJob.status !== "queued") throw new AttemptConflict();

  const now = await databaseClockTimestamp(tx, injectedNow);
  const expiresAt = leaseExpiry(now, leaseDurationMs);
  const deadlineAt = futureTimestamp(now, executionTimeoutMs, "execution timeout");
  const [claimedAttempt] = await tx
    .update(jobAttempts)
    .set({
      status: "running",
      workerId,
      startedAt: now,
      lastHeartbeatAt: now,
      leaseExpiresAt: expiresAt,
      deadlineAt,
    })
    .where(and(eq(jobAttempts.id, attempt.id), eq(jobAttempts.status, "queued")))
    .returning();
  if (!claimedAttempt) throw new AttemptConflict();

  const [job] = await tx
    .update(jobs)
    .set({ status: "running", error: null, updatedAt: now })
    .where(and(eq(jobs.id, attempt.jobId), eq(jobs.status, "queued")))
    .returning();
  if (!job) throw new AttemptConflict();

  return {
    job,
    attempt: {
      ...claimedAttempt,
      status: "running",
      workerId,
      leaseExpiresAt: expiresAt,
    },
  };
}

export async function claimAttemptById(
  db: DrizzleDb,
  attemptId: string,
  workerId: WorkerId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  injectedNow?: Date,
  executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
): Promise<ClaimedExecution | undefined> {
  requireLeaseDuration(leaseDurationMs);
  requireWorkerId(workerId);
  try {
    return await db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(jobAttempts)
        .where(and(eq(jobAttempts.id, attemptId), eq(jobAttempts.status, "queued")))
        .for("update");
      if (!attempt) throw new AttemptConflict();
      return claimLockedAttempt(tx, attempt, workerId, leaseDurationMs, injectedNow, executionTimeoutMs);
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export async function claimNextAttempt(
  db: DrizzleDb,
  workerId: WorkerId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  injectedNow?: Date,
  executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
): Promise<ClaimedExecution | undefined> {
  requireLeaseDuration(leaseDurationMs);
  requireWorkerId(workerId);
  try {
    return await db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(jobAttempts)
        .where(
          and(
            eq(jobAttempts.status, "queued"),
            sql`exists (
              select 1 from ${jobs}
              where ${jobs.id} = ${jobAttempts.jobId}
                and ${jobs.status} = 'queued'
            )`,
          ),
        )
        .orderBy(asc(jobAttempts.createdAt), asc(jobAttempts.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!attempt) throw new AttemptConflict();
      return claimLockedAttempt(tx, attempt, workerId, leaseDurationMs, injectedNow, executionTimeoutMs);
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export interface JobCancellationResult {
  job: JobRow;
  attempt?: JobAttemptRow;
  accepted: boolean;
  notifications: NotificationRow[];
}

async function insertOutcomeNotification(
  tx: DbTransaction,
  job: JobRow,
  status: JobRow["status"],
  error?: string | null,
  summary?: string,
  toolId?: string,
  toolCallId?: string | null,
  pushOverride?: boolean,
): Promise<NotificationRow> {
  const [persona] = await tx.select({ name: personas.name }).from(personas).where(eq(personas.id, job.personaId));
  const message = outcomeNotificationMessage({
    personaName: persona?.name ?? "RetinueOS",
    status,
    error,
    summary,
    toolId,
  });
  const kind: NotificationKind =
    status === "waiting_approval"
      ? "approval_needed"
      : status === "failed" || status === "timed_out" || status === "outcome_unknown"
        ? "job_failed"
        : "job_finished";
  const [notification] = await tx
    .insert(notifications)
    .values({
      personaId: job.personaId,
      jobId: job.id,
      toolCallId: kind === "approval_needed" ? (toolCallId ?? null) : null,
      kind,
      title: notificationTitle(kind, toolId),
      message,
      urgent: status !== "done" && status !== "cancelled",
      waitingApproval: status === "waiting_approval",
      pushOverride: kind === "job_finished" ? (pushOverride ?? null) : null,
      delivered: false,
    })
    .returning();
  return notification;
}

/**
 * Persist cancellation for one job. The active attempt is locked before the
 * aggregate, matching claim/settle and avoiding a job/attempt lock cycle.
 * Running work becomes `cancelling`; the worker owns the final conservative
 * classification. An inline delegated child links its parent signal and
 * invokes this same durable transition before aborting locally.
 */
export async function requestJobCancellation(
  db: DrizzleDb,
  jobId: string,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  injectedNow?: Date,
  reason: AttemptCancelReason = "user",
): Promise<JobCancellationResult | undefined> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(jobAttempts)
      .where(and(eq(jobAttempts.jobId, jobId), sql`${jobAttempts.status} in ('queued', 'running', 'waiting_approval')`))
      .orderBy(desc(jobAttempts.sequence))
      .limit(1);

    const [attempt] = candidate
      ? await tx.select().from(jobAttempts).where(eq(jobAttempts.id, candidate.id)).for("update")
      : [];
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!job) return undefined;
    if (!attempt) {
      return { job, accepted: job.status === "cancelled" || job.status === "timed_out", notifications: [] };
    }

    const now = await databaseClockTimestamp(tx, injectedNow);
    const abortAfter = futureTimestamp(now, abortGraceMs, "abort grace");
    const message = reason === "deadline" ? "Execution deadline exceeded." : "Cancelled by user.";

    if (attempt.status === "queued" && job.status === "queued") {
      const [cancelledAttempt] = await tx
        .update(jobAttempts)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          cancelReason: reason,
          abortAfter,
          finishedAt: now,
          error: message,
        })
        .where(and(eq(jobAttempts.id, attempt.id), eq(jobAttempts.status, "queued")))
        .returning();
      const [cancelledJob] = await tx
        .update(jobs)
        .set({ status: "cancelled", error: message, updatedAt: now })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
        .returning();
      if (!cancelledAttempt || !cancelledJob) throw new AttemptConflict();
      const notification = cancelledAttempt.notifyOnOutcome
        ? await insertOutcomeNotification(
            tx,
            cancelledJob,
            "cancelled",
            message,
            undefined,
            undefined,
            undefined,
            cancelledAttempt.notifyOnOutcome,
          )
        : undefined;
      return {
        job: cancelledJob,
        attempt: cancelledAttempt,
        accepted: true,
        notifications: notification ? [notification] : [],
      };
    }

    if (attempt.status === "running" && (job.status === "running" || job.status === "cancelling")) {
      if (attempt.cancelRequestedAt) return { job, attempt, accepted: true, notifications: [] };
      const [cancellingAttempt] = await tx
        .update(jobAttempts)
        .set({ cancelRequestedAt: now, cancelReason: reason, abortAfter, leaseExpiresAt: abortAfter })
        .where(and(eq(jobAttempts.id, attempt.id), eq(jobAttempts.status, "running")))
        .returning();
      const [cancellingJob] = await tx
        .update(jobs)
        .set({ status: "cancelling", error: null, updatedAt: now })
        .where(and(eq(jobs.id, job.id), sql`${jobs.status} in ('running', 'cancelling')`))
        .returning();
      if (!cancellingAttempt || !cancellingJob) throw new AttemptConflict();
      return { job: cancellingJob, attempt: cancellingAttempt, accepted: true, notifications: [] };
    }

    if (attempt.status === "waiting_approval" && job.status === "waiting_approval") {
      const [cancelledAttempt] = await tx
        .update(jobAttempts)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          cancelReason: reason,
          abortAfter,
          finishedAt: now,
          error: message,
        })
        .where(and(eq(jobAttempts.id, attempt.id), eq(jobAttempts.status, "waiting_approval")))
        .returning();
      await tx
        .update(toolCalls)
        .set({ status: "cancelled" })
        .where(and(eq(toolCalls.jobId, job.id), eq(toolCalls.status, "pending_approval")));
      const [cancelledJob] = await tx
        .update(jobs)
        .set({ status: "cancelled", error: message, updatedAt: now })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "waiting_approval")))
        .returning();
      if (!cancelledAttempt || !cancelledJob) throw new AttemptConflict();
      const notification = cancelledAttempt.notifyOnOutcome
        ? await insertOutcomeNotification(
            tx,
            cancelledJob,
            "cancelled",
            message,
            undefined,
            undefined,
            undefined,
            cancelledAttempt.notifyOnOutcome,
          )
        : undefined;
      return {
        job: cancelledJob,
        attempt: cancelledAttempt,
        accepted: true,
        notifications: notification ? [notification] : [],
      };
    }

    return { job, attempt, accepted: false, notifications: [] };
  });
}

export interface AttemptControl {
  live: boolean;
  abort?: { reason: AttemptCancelReason; requestedAt: Date; abortAfter: Date };
}

/** Heartbeat plus durable deadline/cancellation observation in one lock. */
export async function heartbeatAttemptControl(
  db: DrizzleDb,
  attemptId: string,
  workerId: WorkerId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  injectedNow?: Date,
): Promise<AttemptControl> {
  requireLeaseDuration(leaseDurationMs);
  requireWorkerId(workerId);
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(jobAttempts)
      .where(and(eq(jobAttempts.id, attemptId), eq(jobAttempts.workerId, workerId), eq(jobAttempts.status, "running")))
      .for("update");
    if (!attempt) return { live: false };
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, attempt.jobId)).for("update");
    if (!job || (job.status !== "running" && job.status !== "cancelling")) return { live: false };

    const now = await databaseClockTimestamp(tx, injectedNow);
    let requestedAt = attempt.cancelRequestedAt;
    let reason = attempt.cancelReason;
    let abortAfter = attempt.abortAfter;
    if (
      !requestedAt &&
      attempt.leaseExpiresAt &&
      attempt.leaseExpiresAt > now &&
      attempt.deadlineAt &&
      attempt.deadlineAt <= now
    ) {
      requestedAt = now;
      reason = "deadline";
      abortAfter = futureTimestamp(now, abortGraceMs, "abort grace");
      await tx
        .update(jobAttempts)
        .set({ cancelRequestedAt: requestedAt, cancelReason: reason, abortAfter, leaseExpiresAt: abortAfter })
        .where(eq(jobAttempts.id, attempt.id));
      await tx.update(jobs).set({ status: "cancelling", updatedAt: now }).where(eq(jobs.id, job.id));
    }
    if (requestedAt && reason && abortAfter) {
      return {
        live: Boolean(attempt.leaseExpiresAt && attempt.leaseExpiresAt > now),
        abort: { reason, requestedAt, abortAfter },
      };
    }

    if (!attempt.leaseExpiresAt || attempt.leaseExpiresAt <= now) return { live: false };

    const expiresAt = leaseExpiry(now, leaseDurationMs);
    const [row] = await tx
      .update(jobAttempts)
      .set({ lastHeartbeatAt: now, leaseExpiresAt: expiresAt })
      .where(
        and(
          eq(jobAttempts.id, attemptId),
          eq(jobAttempts.workerId, workerId),
          eq(jobAttempts.status, "running"),
          gt(jobAttempts.leaseExpiresAt, now),
        ),
      )
      .returning({ id: jobAttempts.id });
    return { live: Boolean(row) };
  });
}

export async function heartbeatAttempt(
  db: DrizzleDb,
  attemptId: string,
  workerId: WorkerId,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  injectedNow?: Date,
): Promise<boolean> {
  return (await heartbeatAttemptControl(db, attemptId, workerId, leaseDurationMs, DEFAULT_ABORT_GRACE_MS, injectedNow))
    .live;
}

/**
 * Returns a just-claimed attempt to the queue when shutdown won the race
 * before execution began. Callers must never use this after any model/tool
 * work or other side effect has started.
 */
export async function releaseUnstartedAttempt(db: DrizzleDb, attemptId: string, workerId: WorkerId): Promise<boolean> {
  requireWorkerId(workerId);
  try {
    return await db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(jobAttempts)
        .where(
          and(eq(jobAttempts.id, attemptId), eq(jobAttempts.workerId, workerId), eq(jobAttempts.status, "running")),
        )
        .for("update");
      if (!attempt) throw new AttemptConflict();
      const [job] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, attempt.jobId)).for("update");
      if (!job || job.status !== "running") throw new AttemptConflict();
      const now = await databaseClockTimestamp(tx);

      const [released] = await tx
        .update(jobAttempts)
        .set({
          status: "queued",
          workerId: null,
          leaseExpiresAt: null,
          deadlineAt: null,
          lastHeartbeatAt: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          cancelRequestedAt: null,
          cancelReason: null,
          abortAfter: null,
          externalEffectCallId: null,
          externalEffectStartedAt: null,
        })
        .where(
          and(eq(jobAttempts.id, attemptId), eq(jobAttempts.workerId, workerId), eq(jobAttempts.status, "running")),
        )
        .returning({ id: jobAttempts.id });
      if (!released) throw new AttemptConflict();
      const [queued] = await tx
        .update(jobs)
        .set({ status: "queued", error: null, updatedAt: now })
        .where(and(eq(jobs.id, attempt.jobId), eq(jobs.status, "running")))
        .returning({ id: jobs.id });
      if (!queued) throw new AttemptConflict();
      return true;
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return false;
    throw error;
  }
}

export async function assertLiveAttempt(
  db: DrizzleDb,
  attemptId: string,
  workerId: WorkerId,
  injectedNow?: Date,
): Promise<boolean> {
  // This is an observation for cancellation checks, not a fence around a
  // later write or external side effect. Durable mutations must perform
  // their own worker + live-lease predicate in the same transaction.
  requireWorkerId(workerId);
  const liveLease = injectedNow
    ? gt(jobAttempts.leaseExpiresAt, injectedNow)
    : sql`${jobAttempts.leaseExpiresAt} > clock_timestamp()`;
  const [row] = await db
    .select({ id: jobAttempts.id })
    .from(jobAttempts)
    .where(
      and(
        eq(jobAttempts.id, attemptId),
        eq(jobAttempts.workerId, workerId),
        eq(jobAttempts.status, "running"),
        liveLease,
        sql`${jobAttempts.cancelRequestedAt} is null`,
        injectedNow ? gt(jobAttempts.deadlineAt, injectedNow) : sql`${jobAttempts.deadlineAt} > clock_timestamp()`,
      ),
    );
  return Boolean(row);
}

/**
 * Places a durable uncertainty marker immediately before an external
 * reversible/destructive call. Only one such call may be in flight for an
 * attempt (the graph executes tool calls serially).
 */
export async function beginExternalAttemptEffect(
  db: DrizzleDb,
  lease: AttemptLease,
  callId: string,
  injectedNow?: Date,
): Promise<boolean> {
  requireWorkerId(lease.workerId);
  if (!callId) throw new Error("external effect call id must not be empty");
  try {
    return await db.transaction(async (tx) => {
      const locked = await lockLiveAttempt(tx, lease.attemptId, lease.workerId, injectedNow);
      if (locked.attempt.externalEffectCallId) throw new AttemptConflict();
      const [marked] = await tx
        .update(jobAttempts)
        .set({ externalEffectCallId: callId, externalEffectStartedAt: locked.checkedAt })
        .where(
          and(
            eq(jobAttempts.id, lease.attemptId),
            eq(jobAttempts.workerId, lease.workerId),
            eq(jobAttempts.status, "running"),
            sql`${jobAttempts.externalEffectCallId} is null`,
          ),
        )
        .returning({ id: jobAttempts.id });
      return Boolean(marked);
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return false;
    throw error;
  }
}

export type CompletedExternalEffect = Extract<InFlightAttemptEffect, { type: "record_tool_result" }> & {
  externalEffectCompleted: true;
};

/**
 * The sole write allowed after cancellation starts: record a matching
 * provider response and clear its uncertainty marker atomically. No state,
 * transcript, notification, or child-enqueue effect can use this path.
 */
export async function completeExternalAttemptEffect(
  db: DrizzleDb,
  lease: AttemptLease,
  effect: CompletedExternalEffect,
  injectedNow?: Date,
  injectedFinalNow?: Date,
): Promise<AppliedAttemptEffects | undefined> {
  requireWorkerId(lease.workerId);
  try {
    return await db.transaction(async (tx) => {
      const locked = await lockLiveAttempt(tx, lease.attemptId, lease.workerId, injectedNow, true);
      if (locked.attempt.externalEffectCallId !== effect.callId) throw new AttemptConflict();
      const applied = await applyEffects(tx, locked.job, locked.attempt.id, [effect], locked.checkedAt);
      const [cleared] = await tx
        .update(jobAttempts)
        .set({ externalEffectCallId: null, externalEffectStartedAt: null })
        .where(
          and(
            eq(jobAttempts.id, lease.attemptId),
            eq(jobAttempts.workerId, lease.workerId),
            eq(jobAttempts.status, "running"),
            eq(jobAttempts.externalEffectCallId, effect.callId),
          ),
        )
        .returning({ id: jobAttempts.id });
      if (!cleared) throw new AttemptConflict();
      const finalCheckedAt = await databaseClockTimestamp(tx, injectedFinalNow ?? injectedNow);
      if (locked.attempt.leaseExpiresAt <= finalCheckedAt) throw new AttemptConflict();
      return applied;
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

/**
 * Applies attempt-owned database effects while holding the attempt lease
 * fence. External model, tool, and webhook calls must stay outside this API.
 */
export async function applyAttemptEffects(
  db: DrizzleDb,
  lease: AttemptLease,
  effects: readonly InFlightAttemptEffect[],
  injectedNow?: Date,
  injectedFinalNow?: Date,
): Promise<AppliedAttemptEffects | undefined> {
  requireWorkerId(lease.workerId);
  requireLeaseDuration(lease.leaseDurationMs);
  try {
    return await db.transaction(async (tx) => {
      const locked = await lockLiveAttempt(tx, lease.attemptId, lease.workerId, injectedNow);
      const applied = await applyEffects(tx, locked.job, locked.attempt.id, effects, locked.checkedAt);
      const completedExternal = effects.find(
        (effect) => effect.type === "record_tool_result" && effect.externalEffectCompleted,
      );
      if (completedExternal?.type === "record_tool_result") {
        const [cleared] = await tx
          .update(jobAttempts)
          .set({ externalEffectCallId: null, externalEffectStartedAt: null })
          .where(
            and(eq(jobAttempts.id, lease.attemptId), eq(jobAttempts.externalEffectCallId, completedExternal.callId)),
          )
          .returning({ id: jobAttempts.id });
        if (!cleared) throw new AttemptConflict();
      }
      const renewedAt = await databaseClockTimestamp(tx, injectedFinalNow ?? injectedNow);
      if (locked.attempt.leaseExpiresAt <= renewedAt) throw new AttemptConflict();
      const expiresAt = leaseExpiry(renewedAt, lease.leaseDurationMs);
      const [renewed] = await tx
        .update(jobAttempts)
        .set({ lastHeartbeatAt: renewedAt, leaseExpiresAt: expiresAt })
        .where(
          and(
            eq(jobAttempts.id, lease.attemptId),
            eq(jobAttempts.workerId, lease.workerId),
            eq(jobAttempts.status, "running"),
          ),
        )
        .returning({ id: jobAttempts.id });
      if (!renewed) throw new AttemptConflict();
      return applied;
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export async function settleAttempt(
  db: DrizzleDb,
  attemptId: string,
  workerId: WorkerId,
  outcome: AttemptOutcome,
  injectedNow?: Date,
  injectedFinalNow?: Date,
): Promise<SettledAttempt | undefined> {
  requireWorkerId(workerId);
  try {
    return await db.transaction(async (tx) => {
      const locked = await lockLiveAttempt(tx, attemptId, workerId, injectedNow, true);
      let cancelReason = locked.attempt.cancelReason;
      let cancelRequestedAt = locked.attempt.cancelRequestedAt;
      let abortAfter = locked.attempt.abortAfter;
      if (!cancelReason && locked.attempt.deadlineAt && locked.attempt.deadlineAt <= locked.checkedAt) {
        cancelReason = "deadline";
        cancelRequestedAt = locked.checkedAt;
        abortAfter = new Date(locked.checkedAt.getTime() + 1);
      }
      const terminalStatus = locked.attempt.externalEffectCallId
        ? "outcome_unknown"
        : cancelReason === "deadline"
          ? "timed_out"
          : cancelReason === "user"
            ? "cancelled"
            : outcome.status;
      const effects = terminalStatus === outcome.status && outcome.status !== "failed" ? (outcome.effects ?? []) : [];
      const applied = await applyEffects(tx, locked.job, locked.attempt.id, effects, locked.checkedAt);
      // Effects contain database operations only. Sampling after them gives
      // terminal rows a truthful finish time while the attempt lock prevents
      // recovery from interleaving with this authorized commit.
      const now = await databaseClockTimestamp(tx, injectedFinalNow ?? injectedNow);
      if (locked.attempt.leaseExpiresAt <= now && !cancelReason) throw new AttemptConflict();
      const error =
        terminalStatus === "failed"
          ? outcome.status === "failed"
            ? outcome.error
            : "Attempt failed."
          : terminalStatus === "cancelled"
            ? "Cancelled by user."
            : terminalStatus === "timed_out"
              ? "Execution deadline exceeded."
              : terminalStatus === "outcome_unknown"
                ? `Execution stopped while external call ${locked.attempt.externalEffectCallId ?? "unknown"} may have completed; inspect the provider before retrying.`
                : null;
      const [attempt] = await tx
        .update(jobAttempts)
        .set({
          status: terminalStatus,
          finishedAt: now,
          error,
          cancelRequestedAt,
          cancelReason,
          abortAfter,
        })
        .where(
          and(eq(jobAttempts.id, attemptId), eq(jobAttempts.workerId, workerId), eq(jobAttempts.status, "running")),
        )
        .returning();
      if (!attempt) throw new AttemptConflict();
      const [job] = await tx
        .update(jobs)
        .set({
          status: terminalStatus,
          error,
          updatedAt: now,
        })
        .where(and(eq(jobs.id, attempt.jobId), sql`${jobs.status} in ('running', 'cancelling')`))
        .returning();
      if (!job) throw new AttemptConflict();
      // Opted-in attempts notify on every committed outcome in the selected
      // set. Approvals are blocked work: waiting_approval also notifies when
      // the originating Ask did not opt into "notify me when this finishes".
      const notifyOutcome = attempt.notifyOnOutcome || terminalStatus === "waiting_approval";
      if (notifyOutcome && applied.notifications.length === 0) {
        const summary = effects.find((effect) => effect.type === "append_assistant_message")?.content;
        const pendingToolId = applied.toolCalls[0]?.toolId;
        const pendingToolCallId = applied.toolCalls[0]?.id;
        const notification = await insertOutcomeNotification(
          tx,
          job,
          terminalStatus,
          error,
          summary,
          pendingToolId,
          pendingToolCallId,
          attempt.notifyOnOutcome,
        );
        applied.notifications.push(notification);
      }
      return { ...attempt, job, applied };
    });
  } catch (error) {
    if (error instanceof AttemptConflict) return undefined;
    throw error;
  }
}

export interface RetryEligibility {
  eligible: boolean;
  reason?: string;
}

const RETRYABLE_JOB_STATUSES: readonly JobStatus[] = ["failed", "cancelled", "timed_out"];

/**
 * Whether a job's last attempt can be redone from the last model turn
 * without risking a second external effect or a duplicated user message.
 * Pure and DB-free so it has one home, called by both enqueueRetry's
 * transactional guard and the GET /jobs/:id "should the Retry button be
 * enabled" decoration.
 */
export function evaluateRetryEligibility(
  job: Pick<JobRow, "status">,
  lastAttempt: JobAttemptRow | undefined,
  lastAttemptToolCalls: readonly ToolCallRow[],
): RetryEligibility {
  if (!RETRYABLE_JOB_STATUSES.includes(job.status)) {
    const reason =
      job.status === "done"
        ? "This chat finished successfully — nothing to retry."
        : job.status === "outcome_unknown"
          ? "This chat may have completed an external action before stopping. Inspect the provider — retrying could repeat it."
          : "This chat is still in progress.";
    return { eligible: false, reason };
  }
  if (!lastAttempt) return { eligible: false, reason: "No previous turn to retry." };
  if (lastAttempt.externalEffectCallId) {
    return {
      eligible: false,
      reason: "An external action may not have completed — inspect it before retrying.",
    };
  }
  const ranAnEffect = lastAttemptToolCalls.some(
    (call) =>
      (call.riskClass === "reversible" || call.riskClass === "destructive") &&
      (call.status === "executed" || call.status === "failed"),
  );
  if (ranAnEffect) {
    return { eligible: false, reason: "A tool already ran during this turn — send a new message instead." };
  }
  return { eligible: true };
}

export async function getRetryEligibility(db: DrizzleDb, jobId: string): Promise<RetryEligibility> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return { eligible: false, reason: "job not found" };
  const attempts = await listJobAttempts(db, jobId);
  const lastAttempt = attempts.at(-1);
  // See the matching comment in enqueueRetry: unattributed (null) rows must
  // stay visible here too, or a pre-migration-0023 tool call would silently
  // make a job look retryable.
  const lastAttemptToolCalls = lastAttempt
    ? await db
        .select()
        .from(toolCalls)
        .where(
          and(
            eq(toolCalls.jobId, jobId),
            or(eq(toolCalls.jobAttemptId, lastAttempt.id), isNull(toolCalls.jobAttemptId)),
          ),
        )
    : [];
  return evaluateRetryEligibility(job, lastAttempt, lastAttemptToolCalls);
}

export async function abandonExpiredAttempts(db: DrizzleDb, injectedNow?: Date): Promise<RecoveredAttempt[]> {
  return db.transaction(async (tx) => {
    const expiredLease = injectedNow
      ? lte(jobAttempts.leaseExpiresAt, injectedNow)
      : sql`${jobAttempts.leaseExpiresAt} <= clock_timestamp()`;
    const expired = await tx
      .select()
      .from(jobAttempts)
      .where(and(eq(jobAttempts.status, "running"), expiredLease))
      .orderBy(asc(jobAttempts.leaseExpiresAt), asc(jobAttempts.id))
      .for("update", { skipLocked: true });

    // Preserve the attempt -> aggregate lock order before sampling the clock.
    // Keep each locked aggregate's state so a pre-existing inconsistency can
    // quarantine only that attempt instead of rolling back unrelated recovery.
    const aggregateStatuses = new Map<string, JobRow["status"]>();
    for (const attempt of expired) {
      const [job] = await tx
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, attempt.jobId))
        .for("update");
      if (job) aggregateStatuses.set(job.id, job.status);
    }

    const now = await databaseClockTimestamp(tx, injectedNow);
    const abandoned: RecoveredAttempt[] = [];
    for (const attempt of expired) {
      const aggregateStatus = aggregateStatuses.get(attempt.jobId);
      const status = attempt.externalEffectCallId
        ? "outcome_unknown"
        : attempt.cancelReason === "user"
          ? "cancelled"
          : attempt.cancelReason === "deadline" || (attempt.deadlineAt !== null && attempt.deadlineAt <= now)
            ? "timed_out"
            : "outcome_unknown";
      const message =
        status === "cancelled"
          ? "Cancelled by user."
          : status === "timed_out"
            ? "Execution deadline exceeded."
            : `Worker lease expired for attempt ${attempt.id}; execution outcome is unknown and was not retried.`;
      const [updated] = await tx
        .update(jobAttempts)
        .set({ status, finishedAt: now, error: message })
        .where(
          and(eq(jobAttempts.id, attempt.id), eq(jobAttempts.status, "running"), lte(jobAttempts.leaseExpiresAt, now)),
        )
        .returning();
      if (!updated) continue;

      if (aggregateStatus !== "running" && aggregateStatus !== "cancelling") {
        abandoned.push({ ...updated, notifications: [] });
        continue;
      }

      const [job] = await tx
        .update(jobs)
        .set({ status, error: message, updatedAt: now })
        .where(and(eq(jobs.id, attempt.jobId), sql`${jobs.status} in ('running', 'cancelling')`))
        .returning();
      if (!job) throw new AttemptConflict();
      const notification = updated.notifyOnOutcome
        ? await insertOutcomeNotification(
            tx,
            job,
            status,
            message,
            undefined,
            undefined,
            undefined,
            updated.notifyOnOutcome,
          )
        : undefined;
      abandoned.push({ ...updated, notifications: notification ? [notification] : [] });
    }
    return abandoned;
  });
}

export async function getJobAttempt(db: DrizzleDb, id: string): Promise<JobAttemptRow | undefined> {
  const [row] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, id));
  return row;
}

export function listJobAttempts(db: DrizzleDb, jobId: string): Promise<JobAttemptRow[]> {
  return db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId)).orderBy(asc(jobAttempts.sequence));
}

export async function getQueuedAttemptForJob(db: DrizzleDb, jobId: string): Promise<JobAttemptRow | undefined> {
  const [row] = await db
    .select()
    .from(jobAttempts)
    .where(and(eq(jobAttempts.jobId, jobId), eq(jobAttempts.status, "queued")));
  return row;
}
