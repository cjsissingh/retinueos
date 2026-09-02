import { delegatedChatHref } from "./chat-navigation";

const TOAST_MAX_VISIBLE = 3;
export const TOAST_LIFETIME_MS = 6000;

interface ToastLike {
  persist: boolean;
}

/** Needs-you toasts persist until dismissed; outcome toasts auto-dismiss
 *  at 6s. Dismissing a toast is never the same as marking its
 *  durable twin read -- that distinction lives in notification-repo.ts,
 *  not here; this function only decides the timer. */
export function shouldAutoDismiss(toast: ToastLike): boolean {
  return !toast.persist;
}

/** Caps the stack at TOAST_MAX_VISIBLE, keeping the most recent ones --
 *  the rest collapse into a "+N more" pill the caller renders instead of
 *  a 4th toast. */
export function visibleToasts<T>(toasts: T[], max: number = TOAST_MAX_VISIBLE) {
  const visible = toasts.slice(-max);
  return { visible, overflow: toasts.length - visible.length };
}

export interface SeenReconciliation<T> {
  /** The `seen` ref's next value -- store this back, don't recompute it. */
  seen: Set<string> | null;
  /** Items arriving for the first time, in their original order. */
  arrived: T[];
}

/**
 * Decides how a fresh notifications snapshot affects the "already toasted"
 * set: prime it silently, or diff it and report what's newly arrived.
 * Waits for `ready` -- a live feed's `items` is `[]` before its first real
 * fetch/stream payload lands, and priming off that pre-fetch render would
 * make every existing row look newly arrived the moment real data shows up,
 * replaying a device's whole notification history as toasts on every page
 * load instead of only the ones that are actually new.
 */
export function reconcileSeen<T extends { id: string }>(
  seen: Set<string> | null,
  ready: boolean,
  items: T[],
): SeenReconciliation<T> {
  if (!ready) return { seen, arrived: [] };
  if (seen === null) return { seen: new Set(items.map((item) => item.id)), arrived: [] };
  const arrived = items.filter((item) => !seen.has(item.id));
  if (arrived.length === 0) return { seen, arrived };
  const next = new Set(seen);
  for (const item of arrived) next.add(item.id);
  return { seen: next, arrived };
}

/** A push/toast about a job reopens that job's chat -- the place you'd
 *  actually reply to it or open its follow-on delegate -- not the
 *  read-only activity log. Falls back to the centre when a row has no
 *  job+persona pair to build a chat link from (e.g. routine_ran). */
export function notificationToastHref(item: { jobId: string | null; personaId: string | null }): string {
  return item.jobId && item.personaId
    ? delegatedChatHref({ id: item.jobId, personaId: item.personaId })
    : "/notifications";
}
