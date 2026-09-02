// Single choke point for "which tools may this job call, given how the job
// started". Before this, `jobs.origin` was recorded and shown in
// Logs but nothing consulted it; a cron or delegated job could call any
// tool a human-present chat could. Tier 2 (custom scripts) and Tier 3
// (browser agents) both need some tools to run only from a human-present
// `user` job, so this has to exist before either ships.
import type { ToolSpec } from "./registry.js";

/**
 * How a job was started. Mirrors `jobs.origin` (job-repo.ts's
 * CreateJobInput), widened with `webhook` for future inbound webhooks mapped
 * onto jobs — nothing constructs a webhook-origin job yet,
 * but a future ToolSpec can already declare `requiresOrigin` against it
 * without this module changing.
 */
export type JobOrigin = "user" | "cron" | "delegation" | "webhook";

/**
 * Whether a tool may be called by a job with the given origin. No
 * `requiresOrigin` (the default for every tool today) means callable from
 * any origin — this is additive, not a new restriction on existing tools.
 */
export function originAllowsTool(spec: Pick<ToolSpec, "requiresOrigin">, origin: JobOrigin): boolean {
  if (!spec.requiresOrigin || spec.requiresOrigin.length === 0) return true;
  return spec.requiresOrigin.includes(origin);
}
