import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { notificationQuietHours, type NotificationQuietHoursRow } from "../db/schema.js";

export async function getQuietHours(db: DrizzleDb): Promise<NotificationQuietHoursRow> {
  const [row] = await db.select().from(notificationQuietHours);
  if (row) return row;
  const [seeded] = await db.insert(notificationQuietHours).values({ id: true }).onConflictDoNothing().returning();
  if (seeded) return seeded;
  const [existing] = await db.select().from(notificationQuietHours);
  if (!existing) throw new Error("quiet hours row disappeared after seeding");
  return existing;
}

export async function updateQuietHours(
  db: DrizzleDb,
  patch: { enabled?: boolean; startMinute?: number; endMinute?: number },
): Promise<NotificationQuietHoursRow> {
  await getQuietHours(db);
  const [row] = await db
    .update(notificationQuietHours)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(notificationQuietHours.id, true))
    .returning();
  if (!row) throw new Error("quiet hours row disappeared during update");
  return row;
}

/** Checks the configured server-local window without depending on a real clock. */
export function isWithinQuietHours(
  hours: Pick<NotificationQuietHoursRow, "enabled" | "startMinute" | "endMinute">,
  now: Date,
): boolean {
  if (!hours.enabled) return false;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  if (hours.startMinute === hours.endMinute) return true;
  if (hours.startMinute < hours.endMinute) {
    return minuteOfDay >= hours.startMinute && minuteOfDay < hours.endMinute;
  }
  return minuteOfDay >= hours.startMinute || minuteOfDay < hours.endMinute;
}
