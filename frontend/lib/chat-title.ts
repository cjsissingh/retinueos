import type { Job } from "./api-client";

// A chat's label in the sidebar -- there's no dedicated "title" column, so
// this is the opening message, trimmed. Falls back for the handful of rows
// that predate the `prompt` column (see api-client.ts's Job type). Kept out
// of the page component itself so it's testable without pulling in that
// file's top-level JSX (the icon constants) and the client-component runtime
// it needs.
export function chatTitle(job: Job): string {
  if (!job.prompt) return "Chat";
  return job.prompt.length > 48 ? `${job.prompt.slice(0, 48)}…` : job.prompt;
}
