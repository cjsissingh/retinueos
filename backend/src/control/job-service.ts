import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/client.js";
import type { JobRow, MessageRow, ToolCallRow } from "../db/schema.js";
import { providerEnvVar } from "../config.js";
import { getPersona } from "../personas/persona-repo.js";
import {
  createQueuedJob,
  enqueueContinuation,
  enqueueRetry,
  getRetryEligibility,
  requestJobCancellation,
  type RetryEligibility,
} from "../jobs/job-attempt-repo.js";
import type { JobContinueInput, JobCreateInput } from "../jobs/job-schemas.js";
import {
  getJob,
  listJobs,
  listJobsByFilters,
  listJobsPage,
  listPendingToolCallsPage,
  type JobListFilters,
} from "../jobs/job-repo.js";
import { listMessagesPageByJob } from "../jobs/message-repo.js";
import { listModelCallsByJob } from "../models/model-call-repo.js";
import { deliverNotification } from "../notifications/notify.js";
import {
  claimControlOperation,
  completeControlOperation,
  createControlAuditEvent,
  failControlOperation,
  getControlOperation,
  settleControlAuditEvent,
} from "./control-repo.js";
import { ControlError, type ControlActor, type PageRequest, type PageResult } from "./types.js";
import { broadcastPendingApprovals } from "../orchestration/pending-approval-bus.js";
import { broadcastNotifications } from "../orchestration/notification-bus.js";

export interface JobServiceSettings {
  availableProviders: string[];
}
export interface JobServiceControls {
  abortAttempt?(attemptId: string): void;
  publishStatus?(jobId: string, status: string): void;
}

function requireScope(actor: ControlActor, scope: "jobs:read" | "jobs:write"): void {
  if (actor.kind === "mcp_client" && !actor.scopes.includes(scope)) {
    throw new ControlError("insufficient_scope", `missing required scope: ${scope}`);
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validates a bounded JSON operation result.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function replayJobId(result: Record<string, unknown>): string {
  const job = result.job;
  if (!isRecord(job) || typeof job.id !== "string") {
    throw new ControlError("internal", "completed job operation is missing its job result", true);
  }
  return job.id;
}

/** Shared authorization, idempotency, audit, and durable-job boundary. */
export class JobService {
  constructor(
    private db: DrizzleDb,
    private settings: JobServiceSettings,
    private controls: JobServiceControls = {},
  ) {}

  async listAll(actor: ControlActor, filters: JobListFilters = {}): Promise<JobRow[]> {
    requireScope(actor, "jobs:read");
    const effective = this.effectiveFilters(actor, filters);
    if (effective.parentJobId || effective.personaId) return listJobsByFilters(this.db, effective);
    return listJobs(this.db);
  }

  async listPage(
    actor: ControlActor,
    page: PageRequest = {},
    filters: JobListFilters = {},
  ): Promise<PageResult<JobRow>> {
    requireScope(actor, "jobs:read");
    return listJobsPage(this.db, page, this.effectiveFilters(actor, filters));
  }

  async get(actor: ControlActor, jobId: string): Promise<JobRow | undefined> {
    requireScope(actor, "jobs:read");
    const job = await getJob(this.db, jobId);
    this.assertOwnership(actor, job);
    return job;
  }

  async getDetails(
    actor: ControlActor,
    jobId: string,
    page: PageRequest = {},
  ): Promise<{
    job: JobRow;
    messages: PageResult<MessageRow>;
    pendingApprovals: ToolCallRow[];
  }> {
    const job = await this.get(actor, jobId);
    if (!job) throw new ControlError("not_found", "job not found");
    const messages = await listMessagesPageByJob(this.db, job.id, page);
    const pendingApprovals = await this.allPendingApprovals(job.id);
    return { job, messages, pendingApprovals };
  }

  async listMessagesAll(actor: ControlActor, jobId: string): Promise<MessageRow[]> {
    const job = await this.get(actor, jobId);
    if (!job) throw new ControlError("not_found", "job not found");
    const newestFirst: MessageRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMessagesPageByJob(this.db, job.id, { cursor, limit: 100 });
      newestFirst.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const oldestFirst: MessageRow[] = [];
    for (const message of newestFirst) oldestFirst.unshift(message);
    return oldestFirst;
  }

  async listModelCalls(actor: ControlActor, jobId: string) {
    const job = await this.get(actor, jobId);
    if (!job) throw new ControlError("not_found", "job not found");
    return listModelCallsByJob(this.db, job.id);
  }

  async create(actor: ControlActor, input: JobCreateInput, idempotencyKey: string): Promise<JobRow> {
    requireScope(actor, "jobs:write");
    if (actor.kind === "persona" && actor.personaId !== input.personaId) {
      throw new ControlError("ownership_violation", "persona actors may only create their own jobs");
    }
    const persona = await getPersona(this.db, input.personaId);
    if (!persona) throw new ControlError("not_found", "persona not found");
    this.requireProvider(persona.modelProvider);
    return this.mutate(actor, "job.create", idempotencyKey, input, async () => {
      const queued = await createQueuedJob(this.db, {
        personaId: persona.id,
        depth: 0,
        origin: "user",
        prompt: input.prompt,
        notifyOnOutcome: input.notifyOnOutcome,
        langgraphThreadId: randomUUID(),
      });
      return queued.job;
    });
  }

  async continue(actor: ControlActor, jobId: string, input: JobContinueInput, idempotencyKey: string): Promise<JobRow> {
    requireScope(actor, "jobs:write");
    const job = await this.requireOwnedJob(actor, jobId);
    const persona = await getPersona(this.db, job.personaId);
    if (!persona) throw new ControlError("not_found", "persona not found");
    this.requireProvider(persona.modelProvider);
    const arguments_ = { jobId, ...input };
    // Replay a completed continue *before* the continuable-state check.
    // requireContinuable rejects queued/running jobs, which is correct for a
    // fresh turn — but a client retry after a lost HTTP response or an
    // offline queue reuses the same idempotency key after the first attempt already
    // queued the turn. Checking state first would 409 that retry, and a
    // follow-up send with a new key would duplicate the user message.
    const existing = await getControlOperation(this.db, actor, "job.continue", idempotencyKey, arguments_);
    if (existing?.kind === "completed") return this.loadReplayedJob(existing.result);
    this.requireContinuable(job);
    return this.mutate(
      actor,
      "job.continue",
      idempotencyKey,
      arguments_,
      async () => {
        const queued = await enqueueContinuation(this.db, jobId, input.prompt, {
          notifyOnOutcome: input.notifyOnOutcome,
        });
        if (!queued)
          throw new ControlError(
            "conflict",
            "This chat changed state before the new message could be queued — try again.",
          );
        return queued.job;
      },
      job,
    );
  }

  async retry(actor: ControlActor, jobId: string, idempotencyKey: string): Promise<JobRow> {
    requireScope(actor, "jobs:write");
    const job = await this.requireOwnedJob(actor, jobId);
    const persona = await getPersona(this.db, job.personaId);
    if (!persona) throw new ControlError("not_found", "persona not found");
    this.requireProvider(persona.modelProvider);
    const arguments_ = { jobId };
    // Same replay-before-guard ordering as continue() and for the same
    // reason: a lost HTTP response must replay the prior retry, not 409 or
    // re-enqueue a second one.
    const existing = await getControlOperation(this.db, actor, "job.retry", idempotencyKey, arguments_);
    if (existing?.kind === "completed") return this.loadReplayedJob(existing.result);
    const eligibility = await getRetryEligibility(this.db, jobId);
    if (!eligibility.eligible) throw new ControlError("conflict", eligibility.reason ?? "This chat cannot be retried.");
    return this.mutate(
      actor,
      "job.retry",
      idempotencyKey,
      arguments_,
      async () => {
        const queued = await enqueueRetry(this.db, jobId);
        if (!queued)
          throw new ControlError("conflict", "This chat changed state before the retry could be queued — try again.");
        return queued.job;
      },
      job,
    );
  }

  async retryEligibility(actor: ControlActor, jobId: string): Promise<RetryEligibility> {
    requireScope(actor, "jobs:read");
    await this.requireOwnedJob(actor, jobId);
    return getRetryEligibility(this.db, jobId);
  }

  async cancel(actor: ControlActor, jobId: string, idempotencyKey: string): Promise<JobRow> {
    requireScope(actor, "jobs:write");
    const before = await this.requireOwnedJob(actor, jobId);
    const cancelled = await this.mutate(
      actor,
      "job.cancel",
      idempotencyKey,
      { jobId },
      async () => {
        const result = await requestJobCancellation(this.db, jobId);
        if (!result) throw new ControlError("not_found", "job not found");
        if (!result.accepted) throw new ControlError("conflict", `job cannot be cancelled while ${result.job.status}`);
        if (result.attempt?.status === "running") this.controls.abortAttempt?.(result.attempt.id);
        for (const notification of result.notifications) await deliverNotification(this.db, notification);
        if (result.notifications.length > 0) await broadcastNotifications(this.db);
        this.controls.publishStatus?.(result.job.id, result.job.status);
        // Cancelling a waiting_approval job also flips its pending tool_calls
        // to cancelled in the same transaction — push that snapshot out so the
        // Approvals page and badge don't wait for the 15s poll.
        await broadcastPendingApprovals(this.db);
        return result.job;
      },
      before,
    );
    return cancelled;
  }

  private effectiveFilters(actor: ControlActor, filters: JobListFilters): JobListFilters {
    return actor.kind === "persona" ? { ...filters, personaId: actor.personaId } : filters;
  }

  private assertOwnership(actor: ControlActor, job: JobRow | undefined): void {
    if (job && actor.kind === "persona" && job.personaId !== actor.personaId) {
      throw new ControlError("ownership_violation", "persona actors may only access their own jobs");
    }
  }

  private async requireOwnedJob(actor: ControlActor, jobId: string): Promise<JobRow> {
    const job = await getJob(this.db, jobId);
    if (!job) throw new ControlError("not_found", "job not found");
    this.assertOwnership(actor, job);
    return job;
  }

  private requireProvider(provider: string): void {
    if (this.settings.availableProviders.includes(provider)) return;
    const envVar = providerEnvVar(provider);
    throw new ControlError(
      "conflict",
      `No API key configured for provider "${provider}"${envVar ? ` — set ${envVar} on the backend and restart it.` : "."}`,
    );
  }

  private requireContinuable(job: JobRow): void {
    if (job.status === "done" || job.status === "failed") return;
    const reason =
      job.status === "cancelled"
        ? "This chat was cancelled and cannot be continued — start a new chat instead."
        : job.status === "timed_out"
          ? "This chat timed out and cannot be continued — start a new chat instead."
          : job.status === "outcome_unknown"
            ? "This chat may have completed an external action before stopping. Inspect the provider, then start a new chat."
            : job.status === "cancelling"
              ? "This chat is cancelling — wait for its final status before starting another chat."
              : job.status === "queued" || job.status === "running"
                ? "This chat is still working on the last message — wait for it to finish before sending another."
                : "This chat is waiting on your approval for something — resolve that before sending another message.";
    throw new ControlError("conflict", reason);
  }

  private async allPendingApprovals(jobId: string): Promise<ToolCallRow[]> {
    const items: ToolCallRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await listPendingToolCallsPage(this.db, jobId, { cursor, limit: 100 });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }

  private async mutate(
    actor: ControlActor,
    action: "job.create" | "job.continue" | "job.retry" | "job.cancel",
    idempotencyKey: string,
    arguments_: Record<string, unknown>,
    run: () => Promise<JobRow>,
    before?: JobRow,
  ): Promise<JobRow> {
    const claim = await claimControlOperation(this.db, actor, action, idempotencyKey, arguments_);
    if (claim.kind === "completed") return this.loadReplayedJob(claim.result);
    try {
      const job = await run();
      const audit = await createControlAuditEvent(this.db, {
        actor,
        action,
        targetType: "job",
        targetId: job.id,
        idempotencyKey,
        before: before ? { job: before } : undefined,
        after: { job },
      });
      await completeControlOperation(this.db, claim.operation.id, { job }, "job", job.id);
      await settleControlAuditEvent(this.db, audit.id, "succeeded");
      return job;
    } catch (error) {
      const control =
        error instanceof ControlError ? error : new ControlError("internal", "job operation failed", true);
      await failControlOperation(this.db, claim.operation.id, control);
      throw control;
    }
  }

  private async loadReplayedJob(result: Record<string, unknown>): Promise<JobRow> {
    const job = await getJob(this.db, replayJobId(result));
    if (!job) throw new ControlError("internal", "completed job operation references a missing job", true);
    return job;
  }
}
