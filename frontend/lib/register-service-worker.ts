"use client";

/**
 * registers the offline-shell service worker on every app load.
 * push-enrollment.ts already registers the same /sw.js when a user opts
 * into push -- calling register() again here is a no-op if it's already
 * active (ServiceWorkerContainer.register resolves the existing
 * registration rather than re-installing), so the two don't race.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Offline caching is a progressive enhancement -- nothing else in the
    // app depends on this succeeding.
  });
}
