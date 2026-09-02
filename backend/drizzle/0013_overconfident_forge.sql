CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_valid" CHECK ("messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_job_id_idx" ON "messages" USING btree ("job_id","created_at");--> statement-breakpoint
-- Backfill: every job's existing transcript jsonb array becomes real
-- messages rows before the column carrying it is dropped below. A turn
-- missing "at" (rows written before that field existed) falls back to the
-- job's own created_at rather than being silently skipped.
INSERT INTO "messages" ("job_id", "role", "content", "created_at")
SELECT
	"jobs"."id",
	turn ->> 'role',
	turn ->> 'content',
	coalesce((turn ->> 'at')::timestamptz, "jobs"."created_at")
FROM "jobs", jsonb_array_elements("jobs"."transcript") AS turn
WHERE "jobs"."transcript" IS NOT NULL AND jsonb_array_length("jobs"."transcript") > 0;--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "transcript";