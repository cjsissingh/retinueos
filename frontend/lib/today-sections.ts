import type { Job, JobStatus } from "./api-client";

/**
 * Splits a persona's jobs into the Today screen's "In flight" and "Done
 * today" sections (design guide §01). A job waiting on approval isn't
 * in either list — it surfaces once, as a pending tool call, in "Needs you"
 * (see `app/today/page.tsx`), not twice.
 */

const IN_FLIGHT_STATUSES: ReadonlySet<JobStatus> = new Set(["queued", "running", "cancelling"]);
const DONE_STATUSES: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled", "timed_out", "outcome_unknown"]);
/** Terminal statuses that read as a failure for the greeting's "N things
 *  failed overnight" clause — "cancelled" is an operator choice, not a
 *  failure. */
const FAILED_STATUSES: ReadonlySet<JobStatus> = new Set(["failed", "timed_out", "outcome_unknown"]);

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function byMostRecent(a: Job, b: Job): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function inFlightJobs(jobs: Job[]): Job[] {
  return jobs.filter((j) => IN_FLIGHT_STATUSES.has(j.status)).sort(byMostRecent);
}

/** Distinct personas represented in `jobs` — the greeting's "N people are
 *  working" counts people, not job rows. */
export function workingPersonaCount(jobs: Job[]): number {
  return new Set(jobs.map((j) => j.personaId)).size;
}

export function doneTodayJobs(jobs: Job[], now: Date): Job[] {
  return jobs.filter((j) => DONE_STATUSES.has(j.status) && sameLocalDay(new Date(j.updatedAt), now)).sort(byMostRecent);
}

export function failedTodayCount(doneToday: Job[]): number {
  return doneToday.filter((j) => FAILED_STATUSES.has(j.status)).length;
}

/** "waiting 41m" / "4m ago" -- design guide's elapsed-time convention for
 *  In flight and Done today rows. `now` is injectable for tests. */
export function relativeTimeFrom(iso: string, now: Date): string {
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export interface Collapsed<T> {
  visible: T[];
  hiddenCount: number;
}

/** "Done today (collapsed after five)" — the first five in whatever order
 *  the caller already sorted, plus how many more there are. */
export function collapseAfterFive<T>(items: T[]): Collapsed<T> {
  return { visible: items.slice(0, 5), hiddenCount: Math.max(0, items.length - 5) };
}
