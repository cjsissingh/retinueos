// backend/src/notifications/notify.ts
//
// The push-notification side-channel. Deliberately not a tool a persona
// calls itself — "genuinely time-sensitive" is an orchestration-layer
// judgment (a routine's `notifyRoutineRan` flag, or a specific condition a
// routine checks), the same way JobEventBus.publish is driven by job
// outcome rather than model choice.
import type { DrizzleDb } from "../db/client.js";
import { notifications, type JobStatus, type NotificationKind, type NotificationRow } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { getSettings } from "../config.js";
import { createNotificationDelivery, settleNotificationDelivery } from "./delivery-repo.js";
import { deletePushSubscription, listPushSubscriptions } from "./push-subscription-repo.js";
import { sendWebPush, webPushStatusCode, type PushPayload, type SendWebPush } from "./web-push-transport.js";
import { getNotificationPreference } from "./notification-preference-repo.js";
import { getQuietHours, isWithinQuietHours } from "./notification-quiet-hours-repo.js";
import { listHeldApprovalNotifications, notificationTitle } from "./notification-repo.js";

const TEASER_LIMIT = 200;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

function webhookTimeoutMs(): number {
  const configured = Number(process.env.NOTIFY_WEBHOOK_TIMEOUT_MS ?? DEFAULT_WEBHOOK_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

export interface NotifyInput {
  message: string;
  kind?: NotificationKind;
  title?: string;
  urgent?: boolean;
  personaId?: string;
  jobId?: string;
  waitingApproval?: boolean;
  pushOverride?: boolean;
}

const WAITING_APPROVAL_CLICK_PATH = "/approvals";

/**
 * Durable copy for a job paused on a gated tool. Click-through uses
 * `notifications.waitingApproval`, not this phrasing.
 */
export function waitingApprovalMessage(personaName: string, toolId?: string): string {
  const actor = personaName.trim() || "RetinueOS";
  return toolId ? `${actor} is waiting for approval to use ${toolId}.` : `${actor} is waiting for approval.`;
}

export function outcomeNotificationMessage(input: {
  personaName: string;
  status: JobStatus;
  error?: string | null;
  summary?: string;
  toolId?: string;
}): string {
  if (input.status === "waiting_approval") {
    return waitingApprovalMessage(input.personaName, input.toolId);
  }
  const actor = input.personaName.trim() || "RetinueOS";
  const summarySuffix = input.summary ? ` ${input.summary}` : "";
  return `${actor} ${describeJobOutcome(input.status, input.error)}.${summarySuffix}`;
}

function describeJobOutcome(status: JobStatus, error?: string | null): string {
  switch (status) {
    case "done":
      return "finished";
    case "failed":
      return error ? `failed: ${error}` : "failed";
    case "timed_out":
      return "timed out";
    case "cancelled":
      return "was cancelled";
    default:
      return "stopped with an unknown outcome";
  }
}

export interface NotificationDeliveryOptions {
  sendPush?: SendWebPush;
  fetch?: typeof fetch;
  now?: Date;
}

/**
 * Limits the push teaser to 200 characters so it remains useful on a lock
 * screen. Full content remains in the digest row; the notification only
 * points back to it.
 */
export function toTeaser(message: string): string {
  const characters: string[] = [];
  for (const character of message) {
    if (characters.length === TEASER_LIMIT) {
      return `${characters
        .slice(0, TEASER_LIMIT - 1)
        .join("")
        .trimEnd()}…`;
    }
    characters.push(character);
  }
  return message;
}

/**
 * Delivers via a webhook POST if NOTIFY_WEBHOOK_URL is configured — works
 * as-is against ntfy.sh, a self-hosted ntfy instance, or any endpoint that
 * accepts a POST body (Pushover et al. usually need a small bridge in
 * front, out of scope here). Always writes a durable row to `notifications`
 * first, regardless of whether delivery succeeds or is even configured, so
 * the history survives a missing/misconfigured transport — this is the only
 * "did we actually push anything" record until a transport exists.
 */
export async function notify(
  db: DrizzleDb,
  input: NotifyInput,
  options?: NotificationDeliveryOptions,
): Promise<NotificationRow> {
  const kind = input.kind ?? (input.waitingApproval ? "approval_needed" : input.urgent ? "job_failed" : "job_finished");
  const [row] = await db
    .insert(notifications)
    .values({
      personaId: input.personaId ?? null,
      jobId: input.jobId ?? null,
      kind,
      title: input.title ?? notificationTitle(kind),
      message: input.message,
      urgent: input.urgent ?? false,
      waitingApproval: input.waitingApproval ?? false,
      pushOverride: input.pushOverride ?? null,
      delivered: false,
    })
    .returning();

  return deliverNotification(db, row, options);
}

/**
 * Delivers a notification row that has already committed. Attempt settlement
 * uses this split form so a webhook is never invoked inside its lease-fenced
 * transaction. A crash after the POST but before the delivered update remains
 * outcome-unknown and is deliberately not retried here.
 */
export function buildPushPayload(row: NotificationRow): PushPayload {
  return {
    title: pushTitle(row),
    body: toTeaser(row.message),
    notificationId: row.id,
    path: notificationClickPath(row),
  };
}

function pushTitle(row: NotificationRow): string {
  if (row.waitingApproval) return "RetinueOS — approval needed";
  if (row.urgent) return "RetinueOS — attention needed";
  return "RetinueOS";
}

/**
 * Mirrors frontend/lib/chat-navigation.ts's delegatedChatHref -- a push
 * about a job should land the operator back in that job's chat, not the
 * activity log. /logs/:jobId is a read-only trace of what a job did, not
 * where you'd reply to it or open its follow-on delegate.
 */
function notificationClickPath(row: NotificationRow): string {
  if (row.waitingApproval) return WAITING_APPROVAL_CLICK_PATH;
  if (row.jobId && row.personaId) return `/roster/${row.personaId}?chat=${row.jobId}`;
  if (row.jobId) return `/logs/${row.jobId}`;
  if (row.personaId) return `/roster/${row.personaId}`;
  return "/logs";
}

export async function deliverNotification(
  db: DrizzleDb,
  row: NotificationRow,
  options: NotificationDeliveryOptions = {},
): Promise<NotificationRow> {
  const teaser = toTeaser(row.message);
  const settings = getSettings();
  const now = options.now ?? new Date();
  const pushAllowed = await pushAllowedForRow(db, row, now);
  const subscriptions = settings.webPush && pushAllowed ? await listPushSubscriptions(db) : [];
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  const attempts: Promise<boolean>[] = [];

  for (const subscription of subscriptions) {
    attempts.push(
      (async () => {
        const delivery = await createNotificationDelivery(db, {
          notificationId: row.id,
          transport: "web_push",
          pushSubscriptionId: subscription.id,
          destination: `push:${subscription.id}`,
        });
        try {
          await (options.sendPush ?? sendWebPush)(subscription, buildPushPayload(row), settings.webPush!);
          await settleNotificationDelivery(db, delivery.id, "delivered");
          return true;
        } catch (error) {
          const statusCode = error instanceof Error ? webPushStatusCode(error) : undefined;
          const expired = statusCode === 404 || statusCode === 410;
          await settleNotificationDelivery(
            db,
            delivery.id,
            expired ? "expired" : "failed",
            error instanceof Error ? error.message : String(error),
          );
          if (expired) await deletePushSubscription(db, subscription.endpoint);
          return false;
        }
      })(),
    );
  }

  if (webhookUrl) {
    attempts.push(
      (async () => {
        const delivery = await createNotificationDelivery(db, {
          notificationId: row.id,
          transport: "webhook",
          destination: "webhook",
        });
        try {
          const res = await (options.fetch ?? fetch)(webhookUrl, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: teaser,
            signal: AbortSignal.timeout(webhookTimeoutMs()),
          });
          if (!res.ok) throw new Error(`webhook responded ${res.status}`);
          await settleNotificationDelivery(db, delivery.id, "delivered");
          return true;
        } catch (error) {
          await settleNotificationDelivery(
            db,
            delivery.id,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      })(),
    );
  }

  const results = await Promise.all(attempts);
  if (results.some(Boolean)) {
    const [delivered] = await db
      .update(notifications)
      .set({ delivered: true })
      .where(eq(notifications.id, row.id))
      .returning();
    return delivered ?? row;
  }
  if (webhookUrl && attempts.length > 0) {
    console.error(`notify: every delivery failed for notification ${row.id}`);
  }
  return row;
}

async function pushAllowedForRow(db: DrizzleDb, row: NotificationRow, now: Date): Promise<boolean> {
  const quietHours = await getQuietHours(db);
  if (isWithinQuietHours(quietHours, now)) return false;
  if (row.pushOverride === true) return true;
  const preference = await getNotificationPreference(db, row.kind);
  return preference.pushEnabled;
}

/** Releases approval pushes held during quiet hours while they remain unacted. */
export async function releaseHeldApprovalPush(
  db: DrizzleDb,
  options: NotificationDeliveryOptions = {},
): Promise<NotificationRow[]> {
  const now = options.now ?? new Date();
  const quietHours = await getQuietHours(db);
  if (isWithinQuietHours(quietHours, now)) return [];
  const held = await listHeldApprovalNotifications(db);
  const released: NotificationRow[] = [];
  for (const row of held) {
    released.push(await deliverNotification(db, row, options));
  }
  return released;
}

export async function listNotifications(db: DrizzleDb, limit = 100): Promise<NotificationRow[]> {
  return db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
}
