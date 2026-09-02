export interface PushPayload {
  title: string;
  body: string;
  path: string;
  notificationId?: string;
}

const FALLBACK_PAYLOAD: PushPayload = {
  title: "RetinueOS",
  body: "RetinueOS has an update.",
  path: "/logs",
};

// This helper is part of the parser below: Web Push JSON is untrusted until
// these checks turn individual values into named fields.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Notification data is an I/O boundary supplied by a service worker event.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function safeNotificationPath(path: unknown, origin: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "/logs";
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : "/logs";
  } catch {
    return "/logs";
  }
}

// This is the I/O parser for arbitrary provider/browser push-event JSON.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parsePushPayload(value: unknown): PushPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...FALLBACK_PAYLOAD };
  // SAFETY: the guard above establishes a non-null, non-array object; field
  // values remain unknown and each is validated independently below.
  const record = value as Record<string, unknown>;
  const title = nonEmptyString(record.title);
  const body = nonEmptyString(record.body);
  const path =
    typeof record.path === "string" && record.path.startsWith("/") && !record.path.startsWith("//")
      ? record.path
      : undefined;
  if (!title || !body || !path) return { ...FALLBACK_PAYLOAD };

  const notificationId = nonEmptyString(record.notificationId);
  const payload: PushPayload = { title, body, path };
  if (notificationId) payload.notificationId = notificationId;
  return payload;
}
