CREATE TABLE IF NOT EXISTS "custom_tool_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_key" text NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"parameters_schema" jsonb NOT NULL,
	"host_allow_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"suggested_risk_class" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_tool_proposals_tool_key_version_idx" ON "custom_tool_proposals" USING btree ("tool_key","version");