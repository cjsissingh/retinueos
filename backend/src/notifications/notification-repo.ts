import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { notifications, type NotificationKind, type NotificationRow } from "../db/schema.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const NEEDS_YOU_KINDS: NotificationKind[] = ["approval_needed", "question", "job_failed", "connector_broke"];

const KIND_LABELS = {
  approval_needed: "Approval needed",
  question: "Question",
  job_finished: "Finished",
  job_failed: "Failed",
  routine_ran: "Routine ran",
  connector_broke: "Connector broke",
} satisfies Record<NotificationKind, string>;

export interface PublicNotification {
  id: string;
  kind: NotificationKind;
  personaId: string | null;
  jobId: string | null;
  toolCallId: string | null;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  actedAt: string | null;
}

export function projectNotification(row: NotificationRow): PublicNotification {
  return {
    id: row.id,
    kind: row.kind,
    personaId: row.personaId,
    jobId: row.jobId,
    toolCallId: row.toolCallId,
    title: row.title,
    body: row.message,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    actedAt: row.actedAt?.toISOString() ?? null,
  };
}

/** Builds the title line used by notification rows in the centre. */
export function notificationTitle(kind: NotificationKind, detail?: string): string {
  return detail ? `${KIND_LABELS[kind]} · ${detail}` : KIND_LABELS[kind];
}

export interface InsertNotificationInput {
  kind: NotificationKind;
  title: string;
  message: string;
  personaId?: string | null;
  jobId?: string | null;
  toolCallId?: string | null;
  urgent?: boolean;
  waitingApproval?: boolean;
  pushOverride?: boolean | null;
}

export async function insertNotification(db: DrizzleDb, input: InsertNotificationInput): Promise<NotificationRow> {
  const [row] = await db
    .insert(notifications)
    .values({
      kind: input.kind,
      title: input.title,
      message: input.message,
      personaId: input.personaId ?? null,
      jobId: input.jobId ?? null,
      toolCallId: input.toolCallId ?? null,
      urgent: input.urgent ?? false,
      waitingApproval: input.waitingApproval ?? false,
      pushOverride: input.pushOverride ?? null,
      delivered: false,
    })
    .returning();
  return row;
}

interface Cursor {
  createdAt: string;
  id: string;
}

function decodeCursor(value: string): Cursor {
  try {
    // SAFETY: The shape is validated field-by-field before it escapes this function.
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error("invalid notifications cursor");
  }
}

function encodeCursor(row: NotificationRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}

export async function listNotificationsPage(
  db: DrizzleDb,
  opts: { cursor?: string; limit?: number; needsYou?: boolean },
): Promise<{ items: NotificationRow[]; nextCursor: string | null }> {
  const limit =
    opts.limit === undefined ? DEFAULT_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(opts.limit)));
  const conditions = [];
  if (opts.needsYou) {
    conditions.push(isNull(notifications.readAt));
    conditions.push(inArray(notifications.kind, NEEDS_YOU_KINDS));
  }
  if (opts.cursor) {
    const cursor = decodeCursor(opts.cursor);
    const createdAt = new Date(cursor.createdAt);
    const afterCursor = or(
      lt(notifications.createdAt, createdAt),
      and(eq(notifications.createdAt, createdAt), lt(notifications.id, cursor.id)),
    );
    if (afterCursor) conditions.push(afterCursor);
  }
  const rows = await db
    .select()
    .from(notifications)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  return { items, nextCursor: rows.length > limit && lastItem ? encodeCursor(lastItem) : null };
}

export async function markNotificationRead(db: DrizzleDb, id: string): Promise<NotificationRow | undefined> {
  const [row] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(notifications).where(eq(notifications.id, id));
  return existing;
}

export async function markAllNotificationsRead(db: DrizzleDb): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(isNull(notifications.readAt))
    .returning({ id: notifications.id });
  return rows.length;
}

/** Keeps notification action state in sync when an approval resolves elsewhere. */
export async function markNotificationActedByToolCallId(
  db: DrizzleDb,
  toolCallId: string,
): Promise<NotificationRow | undefined> {
  const [row] = await db
    .update(notifications)
    .set({ actedAt: new Date() })
    .where(and(eq(notifications.toolCallId, toolCallId), isNull(notifications.actedAt)))
    .returning();
  return row;
}

export async function listHeldApprovalNotifications(db: DrizzleDb): Promise<NotificationRow[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.kind, "approval_needed"),
        isNull(notifications.actedAt),
        sql`not exists (
          select 1 from notification_deliveries
          where notification_deliveries.notification_id = ${notifications.id}
            and notification_deliveries.transport = 'web_push'
        )`,
      ),
    )
    .orderBy(asc(notifications.createdAt));
}
