CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"kind" text PRIMARY KEY NOT NULL,
	"in_app_enabled" boolean NOT NULL,
	"push_enabled" boolean NOT NULL,
	"digest_enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_kind_valid" CHECK ("notification_preferences"."kind" in ('approval_needed', 'question', 'job_finished', 'job_failed', 'routine_ran', 'connector_broke'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_quiet_hours" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"start_minute" integer DEFAULT 1320 NOT NULL,
	"end_minute" integer DEFAULT 420 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_quiet_hours_singleton" CHECK ("notification_quiet_hours"."id" = true),
	CONSTRAINT "notification_quiet_hours_start_minute_valid" CHECK ("notification_quiet_hours"."start_minute" >= 0 and "notification_quiet_hours"."start_minute" < 1440),
	CONSTRAINT "notification_quiet_hours_end_minute_valid" CHECK ("notification_quiet_hours"."end_minute" >= 0 and "notification_quiet_hours"."end_minute" < 1440)
);
--> statement-breakpoint
ALTER TABLE "routines" RENAME COLUMN "notify_direct" TO "notify_routine_ran";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "tool_call_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "kind" text DEFAULT 'job_finished' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "push_override" boolean;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "acted_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_unread_needs_you_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."read_at" is null and "notifications"."kind" in ('approval_needed', 'question', 'job_failed', 'connector_broke');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" in ('approval_needed', 'question', 'job_finished', 'job_failed', 'routine_ran', 'connector_broke'));