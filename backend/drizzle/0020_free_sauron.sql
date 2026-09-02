CREATE TABLE IF NOT EXISTS "control_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"source_job_id" text,
	"source_tool_call_id" text,
	"mcp_request_id" text,
	"idempotency_key" text,
	"correlation_id" text,
	"before" jsonb,
	"after" jsonb,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"error_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "control_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "control_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_key" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"arguments_hash" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"target_type" text,
	"target_id" text,
	"result" jsonb,
	"error_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "control_audit_events_created_at_idx" ON "control_audit_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "control_clients_token_hash_idx" ON "control_clients" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "control_operations_actor_action_idempotency_idx" ON "control_operations" USING btree ("actor_key","action","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personas_created_at_idx" ON "personas" USING btree ("created_at","id");