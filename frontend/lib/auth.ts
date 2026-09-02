import { ApiError } from "./api-client";

const STORAGE_KEY = "retinueos-auth-password";
const LOGIN_FALLBACK = "/today";
const INTERNAL_ORIGIN = "http://retinueos.internal";

export function safeLoginRedirect(candidate: string | null): string {
  if (!candidate?.startsWith("/")) return LOGIN_FALLBACK;

  try {
    const destination = new URL(candidate, INTERNAL_ORIGIN);
    if (destination.origin !== INTERNAL_ORIGIN) return LOGIN_FALLBACK;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return LOGIN_FALLBACK;
  }
}

export function getStoredPassword(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setStoredPassword(password: string): void {
  window.localStorage.setItem(STORAGE_KEY, password);
}

export function clearStoredPassword(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Shared 401 handling (M7): any request that comes back unauthorized clears
 * the stale password and sends the user back to /login with a `next` so
 * they land where they were. Returns true if it handled the error (caller
 * should stop, not also render a generic error state).
 */
// `err` is whatever a caller's catch block caught -- narrowed below via
// `instanceof ApiError` before use, the standard TS pattern for a caught
// exception of unknown provenance.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function handleUnauthorized(err: unknown, router: { push: (href: string) => void }): boolean {
  if (err instanceof ApiError && err.status === 401) {
    clearStoredPassword();
    const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
    router.push(`/login?next=${encodeURIComponent(next)}`);
    return true;
  }
  return false;
}
