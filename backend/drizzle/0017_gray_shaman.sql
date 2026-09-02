ALTER TABLE "mcp_servers" ADD COLUMN "auth_type" text DEFAULT 'bearer' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_secret" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_authorization_endpoint" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_token_endpoint" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_scope" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_refresh_token" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_access_token" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_pending_state" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_pending_state_expires_at" timestamp with time zone;