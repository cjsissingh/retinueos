/**
 * when the offline banner says "showing what we had at HH:MM", this
 * is where HH:MM comes from -- the last time app-shell.tsx's poll actually
 * reached the backend, recorded to localStorage so it survives a reload
 * that happens while offline. Kept as small pure read/write functions
 * (rather than reaching for the Cache API's own response timestamps) so
 * the formatting logic is unit-testable and any successful sync counts,
 * not only a fetch the service worker happened to cache.
 */
const STORAGE_KEY = "retinueos-last-synced-at";

export function recordSync(now: number = Date.now()): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    // Private-mode / storage-blocked browsers: the banner falls back to
    // "showing what we had" with no time, which is still true.
  }
}

export function getLastSyncedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function offlineBannerText(lastSyncedAt: number | null, now: number = Date.now()): string {
  if (lastSyncedAt === null) return "Offline · showing what we had.";
  const at = new Date(lastSyncedAt);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const stale = now - lastSyncedAt > 24 * 60 * 60 * 1000;
  return stale ? "Offline · showing what we had — it's been a while." : `Offline · showing what we had at ${hh}:${mm}`;
}
