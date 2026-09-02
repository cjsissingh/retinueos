ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_input_valid";--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "job_attempt_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_job_attempt_id_job_attempts_id_fk" FOREIGN KEY ("job_attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_input_valid" CHECK ((
        jsonb_typeof("job_attempts"."input") = 'object'
        and (
          ("job_attempts"."input"->>'type' = 'user_message' and jsonb_typeof("job_attempts"."input"->'content') = 'string')
          or (
            "job_attempts"."input"->>'type' = 'approval_resume'
            and jsonb_typeof("job_attempts"."input"->'toolCallId') = 'string'
            and jsonb_typeof("job_attempts"."input"->'approved') = 'boolean'
          )
          or "job_attempts"."input"->>'type' = 'retry'
        )
      ) is true);