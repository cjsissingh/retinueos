ALTER TABLE "personas" ADD COLUMN "reports_to" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "personas" ADD CONSTRAINT "personas_reports_to_personas_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
