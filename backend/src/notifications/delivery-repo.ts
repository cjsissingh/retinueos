import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import {
  notificationDeliveries,
  type NotificationDeliveryRow,
  type NotificationDeliveryStatus,
  type NotificationDeliveryTransport,
} from "../db/schema.js";

export interface CreateNotificationDeliveryInput {
  notificationId: string;
  transport: NotificationDeliveryTransport;
  pushSubscriptionId?: string | null;
  destination: string;
}

export async function createNotificationDelivery(
  db: DrizzleDb,
  input: CreateNotificationDeliveryInput,
): Promise<NotificationDeliveryRow> {
  const [created] = await db
    .insert(notificationDeliveries)
    .values({
      notificationId: input.notificationId,
      transport: input.transport,
      pushSubscriptionId: input.pushSubscriptionId ?? null,
      destination: input.destination,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.notificationId, input.notificationId),
        eq(notificationDeliveries.transport, input.transport),
        eq(notificationDeliveries.destination, input.destination),
      ),
    );
  if (!existing) throw new Error(`notification delivery destination ${input.destination} disappeared`);
  return existing;
}

export async function settleNotificationDelivery(
  db: DrizzleDb,
  id: string,
  status: Exclude<NotificationDeliveryStatus, "pending">,
  error?: string,
): Promise<NotificationDeliveryRow> {
  const [row] = await db
    .update(notificationDeliveries)
    .set({ status, error: error?.slice(0, 2_000) ?? null, updatedAt: new Date() })
    .where(eq(notificationDeliveries.id, id))
    .returning();
  if (!row) throw new Error(`notification delivery ${id} disappeared`);
  return row;
}

export async function listNotificationDeliveries(
  db: DrizzleDb,
  notificationId: string,
): Promise<NotificationDeliveryRow[]> {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.notificationId, notificationId))
    .orderBy(notificationDeliveries.createdAt, notificationDeliveries.id);
}
