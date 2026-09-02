CREATE TABLE IF NOT EXISTS "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_attempts_sequence_positive" CHECK ("job_attempts"."sequence" > 0),
	CONSTRAINT "job_attempts_status_valid" CHECK ("job_attempts"."status" in ('queued', 'running', 'waiting_approval', 'done', 'failed', 'abandoned')),
	CONSTRAINT "job_attempts_input_valid" CHECK ((
        jsonb_typeof("job_attempts"."input") = 'object'
        and (
          ("job_attempts"."input"->>'type' = 'user_message' and jsonb_typeof("job_attempts"."input"->'content') = 'string')
          or (
            "job_attempts"."input"->>'type' = 'approval_resume'
            and jsonb_typeof("job_attempts"."input"->'toolCallId') = 'string'
            and jsonb_typeof("job_attempts"."input"->'approved') = 'boolean'
          )
        )
      ) is true),
	CONSTRAINT "job_attempts_lifecycle_valid" CHECK ((
        "job_attempts"."status" = 'queued'
        and "job_attempts"."worker_id" is null
        and "job_attempts"."lease_expires_at" is null
        and "job_attempts"."last_heartbeat_at" is null
        and "job_attempts"."started_at" is null
        and "job_attempts"."finished_at" is null
      ) or (
        "job_attempts"."status" = 'running'
        and "job_attempts"."worker_id" is not null
        and "job_attempts"."lease_expires_at" is not null
        and "job_attempts"."last_heartbeat_at" is not null
        and "job_attempts"."started_at" is not null
        and "job_attempts"."finished_at" is null
      ) or (
        "job_attempts"."status" in ('waiting_approval', 'done', 'failed', 'abandoned')
        and "job_attempts"."worker_id" is not null
        and "job_attempts"."lease_expires_at" is not null
        and "job_attempts"."last_heartbeat_at" is not null
        and "job_attempts"."started_at" is not null
        and "job_attempts"."finished_at" is not null
      ))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_attempts_job_sequence_idx" ON "job_attempts" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_attempts_one_active_per_job_idx" ON "job_attempts" USING btree ("job_id") WHERE "job_attempts"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_attempts_claim_idx" ON "job_attempts" USING btree ("created_at","id") WHERE "job_attempts"."status" = 'queued';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_attempts_expired_lease_idx" ON "job_attempts" USING btree ("lease_expires_at","id") WHERE "job_attempts"."status" = 'running';