/**
 * which requests public/sw.js treats as part of the offline app
 * shell. Kept here, mirrored by hand into sw.js -- which runs as a classic
 * script, not a module, so it can't import this file, the same split
 * lib/push-payload.ts already uses for sw.js's push-handling logic -- so
 * the route-matching rules are unit-testable.
 *
 * The three shelled routes are Today, the last-opened chat, and the
 * notification centre at /notifications.
 */
const SHELL_ROUTE_PATTERNS = [/^\/today\/?$/, /^\/notifications\/?$/, /^\/roster\/[^/]+\/?$/];

export function isShellRoute(pathname: string): boolean {
  return SHELL_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** Next's content-hashed JS/CSS chunks, plus the icons and manifest the
 *  shell routes render -- safe to cache unconditionally since they're
 *  shared across routes and either immutable (hashed) or already public. */
export function isCacheableStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/static/") || pathname.startsWith("/icons/") || pathname === "/manifest.webmanifest"
  );
}

/** SSE (job streams, pending-approvals stream) must never be intercepted:
 *  caching a long-lived event stream's "response" would serve a frozen
 *  snapshot instead of ever letting a real connection through. */
export function isStreamingRequest(acceptHeader: string | null): boolean {
  return (acceptHeader ?? "").includes("text/event-stream");
}
