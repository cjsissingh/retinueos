import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { notificationPreferences, type NotificationKind, type NotificationPreferenceRow } from "../db/schema.js";

const NOTIFICATION_KINDS: NotificationKind[] = [
  "approval_needed",
  "question",
  "job_finished",
  "job_failed",
  "routine_ran",
  "connector_broke",
];

export const NOTIFICATION_PREFERENCE_DEFAULTS = {
  approval_needed: { inAppEnabled: true, pushEnabled: true, digestEnabled: false },
  question: { inAppEnabled: true, pushEnabled: true, digestEnabled: false },
  job_finished: { inAppEnabled: true, pushEnabled: false, digestEnabled: true },
  job_failed: { inAppEnabled: true, pushEnabled: true, digestEnabled: false },
  routine_ran: { inAppEnabled: false, pushEnabled: false, digestEnabled: true },
  connector_broke: { inAppEnabled: true, pushEnabled: true, digestEnabled: false },
} satisfies Record<NotificationKind, { inAppEnabled: boolean; pushEnabled: boolean; digestEnabled: boolean }>;

/** In-app stays enabled where the operator is the only fallback for a blocked agent. */
const FORCED_IN_APP_KINDS: ReadonlySet<NotificationKind> = new Set([
  "approval_needed",
  "question",
  "job_failed",
  "connector_broke",
]);

export class ForcedChannelError extends Error {
  constructor(kind: NotificationKind) {
    super(`in-app notifications for "${kind}" cannot be disabled -- it is a forced channel`);
    this.name = "ForcedChannelError";
  }
}

export async function ensureNotificationPreferencesSeeded(db: DrizzleDb): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values(NOTIFICATION_KINDS.map((kind) => ({ kind, ...NOTIFICATION_PREFERENCE_DEFAULTS[kind] })))
    .onConflictDoNothing();
}

export async function listNotificationPreferences(db: DrizzleDb): Promise<NotificationPreferenceRow[]> {
  await ensureNotificationPreferencesSeeded(db);
  return db.select().from(notificationPreferences).orderBy(notificationPreferences.kind);
}

export async function getNotificationPreference(
  db: DrizzleDb,
  kind: NotificationKind,
): Promise<NotificationPreferenceRow> {
  await ensureNotificationPreferencesSeeded(db);
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.kind, kind));
  if (!row) throw new Error(`notification preference for "${kind}" is missing after seeding`);
  return row;
}

export async function updateNotificationPreference(
  db: DrizzleDb,
  kind: NotificationKind,
  patch: { pushEnabled?: boolean; digestEnabled?: boolean; inAppEnabled?: boolean },
): Promise<NotificationPreferenceRow> {
  if (patch.inAppEnabled === false && FORCED_IN_APP_KINDS.has(kind)) {
    throw new ForcedChannelError(kind);
  }
  await ensureNotificationPreferencesSeeded(db);
  const [row] = await db
    .update(notificationPreferences)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(notificationPreferences.kind, kind))
    .returning();
  if (!row) throw new Error(`notification preference for "${kind}" disappeared`);
  return row;
}
