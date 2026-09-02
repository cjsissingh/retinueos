import { count, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { pushSubscriptions, type PushSubscriptionRow } from "../db/schema.js";

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export async function upsertPushSubscription(
  db: DrizzleDb,
  input: PushSubscriptionInput,
): Promise<PushSubscriptionRow> {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function deletePushSubscription(db: DrizzleDb, endpoint: string): Promise<boolean> {
  const rows = await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).returning({
    id: pushSubscriptions.id,
  });
  return rows.length > 0;
}

export async function listPushSubscriptions(db: DrizzleDb): Promise<PushSubscriptionRow[]> {
  return db.select().from(pushSubscriptions).orderBy(pushSubscriptions.createdAt, pushSubscriptions.id);
}

export async function countPushSubscriptions(db: DrizzleDb): Promise<number> {
  const [row] = await db.select({ value: count() }).from(pushSubscriptions);
  return row?.value ?? 0;
}
