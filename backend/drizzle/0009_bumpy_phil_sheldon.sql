ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_status_valid";--> statement-breakpoint
ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "abort_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "external_effect_call_id" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "external_effect_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "job_attempts"
SET "deadline_at" = coalesce("started_at", "created_at") + interval '5 minutes'
WHERE "worker_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_attempts_deadline_idx" ON "job_attempts" USING btree ("deadline_at","id") WHERE "job_attempts"."status" = 'running' and "job_attempts"."cancel_requested_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_attempts_abort_after_idx" ON "job_attempts" USING btree ("abort_after","id") WHERE "job_attempts"."status" = 'running' and "job_attempts"."cancel_requested_at" is not null;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_cancellation_valid" CHECK ((
        "job_attempts"."cancel_requested_at" is null
        and "job_attempts"."cancel_reason" is null
        and "job_attempts"."abort_after" is null
      ) or (
        "job_attempts"."cancel_requested_at" is not null
        and "job_attempts"."cancel_reason" in ('user', 'deadline')
        and "job_attempts"."abort_after" is not null
        and "job_attempts"."abort_after" > "job_attempts"."cancel_requested_at"
      ));--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_external_effect_valid" CHECK (("job_attempts"."external_effect_call_id" is null) = ("job_attempts"."external_effect_started_at" is null));--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_status_valid" CHECK ("job_attempts"."status" in ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled', 'timed_out', 'outcome_unknown', 'abandoned'));--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_lifecycle_valid" CHECK ((
        "job_attempts"."status" = 'queued'
        and "job_attempts"."worker_id" is null
        and "job_attempts"."lease_expires_at" is null
        and "job_attempts"."last_heartbeat_at" is null
        and "job_attempts"."started_at" is null
        and "job_attempts"."finished_at" is null
        and "job_attempts"."deadline_at" is null
        and "job_attempts"."cancel_requested_at" is null
        and "job_attempts"."external_effect_call_id" is null
      ) or (
        "job_attempts"."status" = 'running'
        and "job_attempts"."worker_id" is not null
        and "job_attempts"."lease_expires_at" is not null
        and "job_attempts"."last_heartbeat_at" is not null
        and "job_attempts"."started_at" is not null
        and "job_attempts"."finished_at" is null
        and "job_attempts"."deadline_at" is not null
      ) or (
        "job_attempts"."status" in ('waiting_approval', 'done', 'failed', 'cancelled', 'timed_out', 'outcome_unknown', 'abandoned')
        and "job_attempts"."worker_id" is not null
        and "job_attempts"."lease_expires_at" is not null
        and "job_attempts"."last_heartbeat_at" is not null
        and "job_attempts"."started_at" is not null
        and "job_attempts"."finished_at" is not null
        and "job_attempts"."deadline_at" is not null
      ) or (
        "job_attempts"."status" = 'cancelled'
        and "job_attempts"."worker_id" is null
        and "job_attempts"."lease_expires_at" is null
        and "job_attempts"."last_heartbeat_at" is null
        and "job_attempts"."started_at" is null
        and "job_attempts"."finished_at" is not null
        and "job_attempts"."deadline_at" is null
      ));--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_status_valid";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('queued', 'running', 'cancelling', 'waiting_approval', 'done', 'failed', 'cancelled', 'timed_out', 'outcome_unknown'));
