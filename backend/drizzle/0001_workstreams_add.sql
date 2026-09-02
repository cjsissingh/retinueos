CREATE TABLE IF NOT EXISTS "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_tool_id_unique" UNIQUE("tool_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"routine_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid,
	"job_id" uuid,
	"message" text NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "persona_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"key" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron_schedule" text NOT NULL,
	"prompt_template" text NOT NULL,
	"notify_direct" boolean DEFAULT false NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_summary" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "routine_id" uuid;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "voice_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "boundaries" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "scope_description" text DEFAULT '' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "digests" ADD CONSTRAINT "digests_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "persona_state" ADD CONSTRAINT "persona_state_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "routines" ADD CONSTRAINT "routines_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "persona_state_persona_id_key_idx" ON "persona_state" USING btree ("persona_id","key");
--> statement-breakpoint
-- Data migration: personas.cron_schedule (one field, one canned check-in)
-- becomes routines (many named, scheduled jobs per persona). Every persona
-- that had a schedule gets one routine carrying it forward unchanged, named
-- "Check-in", so nothing that was firing stops firing. cron_schedule itself
-- is dropped in the next migration once this backfill has run.
INSERT INTO "routines" ("persona_id", "name", "cron_schedule", "prompt_template")
SELECT "id", 'Check-in', "cron_schedule", 'Perform your scheduled check-in.'
FROM "personas"
WHERE "cron_schedule" IS NOT NULL;
--> statement-breakpoint
-- Data migration: assigned_tool_ids goes from a flat string[] of tool ids to
-- AssignedToolConfig[] ({toolId, autonomy?}) — see AssignedToolConfig in
-- schema.ts. Only touches rows still shaped as an array of strings, so this
-- is safe to run once and safe to skip if already-migrated data exists.
UPDATE "personas"
SET "assigned_tool_ids" = (
	SELECT COALESCE(jsonb_agg(jsonb_build_object('toolId', elem)), '[]'::jsonb)
	FROM jsonb_array_elements_text("assigned_tool_ids") AS elem
)
WHERE jsonb_typeof("assigned_tool_ids") = 'array'
  AND jsonb_array_length("assigned_tool_ids") > 0
  AND jsonb_typeof("assigned_tool_ids"->0) = 'string';