const FALLBACK_PAYLOAD = {
  title: "RetinueOS",
  body: "RetinueOS has an update.",
  path: "/logs",
};

function parsePushPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...FALLBACK_PAYLOAD };
  const title = typeof value.title === "string" && value.title.trim() ? value.title : undefined;
  const body = typeof value.body === "string" && value.body.trim() ? value.body : undefined;
  const path =
    typeof value.path === "string" && value.path.startsWith("/") && !value.path.startsWith("//")
      ? value.path
      : undefined;
  if (!title || !body || !path) return { ...FALLBACK_PAYLOAD };
  const notificationId =
    typeof value.notificationId === "string" && value.notificationId.trim() ? value.notificationId : undefined;
  const payload = { title, body, path };
  if (notificationId) payload.notificationId = notificationId;
  return payload;
}

function safeNotificationPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "/logs";
  try {
    const url = new URL(path, self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/logs";
  } catch {
    return "/logs";
  }
}

self.addEventListener("push", (event) => {
  let value = null;
  try {
    value = event.data ? event.data.json() : null;
  } catch {
    value = null;
  }
  const payload = parsePushPayload(value);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/retinueos-192.png",
      badge: "/icons/retinueos-192.png",
      tag: payload.notificationId ? `retinueos-${payload.notificationId}` : undefined,
      data: { path: payload.path },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safeNotificationPath(event.notification.data?.path);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const existing = windowClients.find((client) => client.url === target);
      return existing ? existing.focus() : self.clients.openWindow(target);
    }),
  );
});

// offline app shell -- stale-while-revalidate for Today, the
// notification centre at /notifications, and
// whichever chat page was last opened, plus their JS/CSS and API payloads.
// This block is a classic script (no ES module imports, so it can't share
// lib/sw-cache-routes.ts directly) -- these three matchers are hand-mirrors
// of that file's isShellRoute / isCacheableStaticAsset / isStreamingRequest,
// which is where they're unit tested. Keep them in sync by hand.
const SHELL_CACHE = "retinueos-shell-v1";
const SHELL_ROUTE_PATTERNS = [/^\/today\/?$/, /^\/notifications\/?$/, /^\/roster\/[^/]+\/?$/];

function isShellRoute(pathname) {
  return SHELL_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

function isCacheableStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") || pathname.startsWith("/icons/") || pathname === "/manifest.webmanifest"
  );
}

function isStreamingRequest(request) {
  return (request.headers.get("accept") || "").includes("text/event-stream");
}

// Serves the cached response immediately (if there is one) while a network
// fetch runs in the background to refresh the cache for next time. Offline
// with nothing cached yet, this rejects and the browser/page's own
// loading/error state takes over -- there was never anything to show.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const revalidate = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const fresh = await revalidate;
  if (fresh) return fresh;
  throw new Error("offline, and nothing cached for this request yet");
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name)))),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || isStreamingRequest(request)) return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const cacheable = request.mode === "navigate" ? isShellRoute(url.pathname) : isCacheableStaticAsset(url.pathname);
    if (!cacheable) return; // not part of the shell -- let the browser/Next handle it normally
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Cross-origin GETs are the backend's API responses (jobs, personas,
  // messages, notification prefs) for whichever shell route is open, plus
  // the Google Fonts stylesheet/files globals.css imports -- "last
  // payload" for the shelled routes falls out of caching these the same
  // way, without this file needing to know NEXT_PUBLIC_BACKEND_URL (it's
  // not processed by Next's env substitution).
  event.respondWith(staleWhileRevalidate(request));
});
