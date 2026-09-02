CREATE TABLE IF NOT EXISTS "persona_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL,
	"label" text NOT NULL,
	"content" text NOT NULL,
	"source_job_id" uuid,
	"supersedes_id" uuid,
	"superseded_at" timestamp with time zone,
	"sensitivity" text DEFAULT 'normal' NOT NULL,
	"importance" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "persona_memories" ADD CONSTRAINT "persona_memories_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "persona_memories" ADD CONSTRAINT "persona_memories_source_job_id_jobs_id_fk" FOREIGN KEY ("source_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "persona_memories" ADD CONSTRAINT "persona_memories_supersedes_id_persona_memories_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."persona_memories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Functional GIN index backing persona-memory-repo.ts's recallMemories —
-- hand-written rather than declared in schema.ts because it indexes an
-- expression (to_tsvector over two concatenated columns), not a plain
-- column list; Drizzle's index builder has no representation for that, so
-- schema.ts stays the source of truth for columns/constraints and this one
-- expression index is maintained here instead.
CREATE INDEX IF NOT EXISTS "persona_memories_fts_idx" ON "persona_memories"
  USING gin (to_tsvector('english', "label" || ' ' || "content"));
