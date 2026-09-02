import type { NotificationKind, NotificationRow } from "./api-client";

/** Kinds that put a number on the bell -- a finished job never does
 *  (design doc §04: "Badge = unread needs-you count, never total unread"). */
export const NEEDS_YOU_KINDS: readonly NotificationKind[] = [
  "approval_needed",
  "question",
  "job_failed",
  "connector_broke",
];

export function isNeedsYou(row: NotificationRow): boolean {
  return row.readAt === null && NEEDS_YOU_KINDS.includes(row.kind);
}

export const KIND_LABELS = {
  approval_needed: "Approval needed",
  question: "Question",
  job_finished: "Finished",
  job_failed: "Failed",
  routine_ran: "Routine ran",
  connector_broke: "Connector broke",
} as const satisfies Record<NotificationKind, string>;
