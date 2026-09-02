import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import {
  listNotificationsPage,
  markAllNotificationsRead,
  markNotificationRead,
  projectNotification,
} from "./notification-repo.js";
import { listDigests, getDigest } from "./digest-repo.js";
import { generateDigest } from "./digest-generator.js";
import { getSettings } from "../config.js";
import { countPushSubscriptions, deletePushSubscription, upsertPushSubscription } from "./push-subscription-repo.js";
import { PushSubscriptionDeleteSchema, PushSubscriptionSchema } from "./push-subscription-schemas.js";
import {
  ForcedChannelError,
  listNotificationPreferences,
  updateNotificationPreference,
} from "./notification-preference-repo.js";
import { getQuietHours, updateQuietHours } from "./notification-quiet-hours-repo.js";
import {
  NotificationKindSchema,
  NotificationPreferenceUpdateSchema,
  QuietHoursUpdateSchema,
} from "./notification-preference-schemas.js";
import { broadcastNotifications } from "../orchestration/notification-bus.js";

export function notificationRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.get("/notifications", async (c) => {
    const cursor = c.req.query("cursor") ?? undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const needsYou = c.req.query("needs_you") === "true";
    const page = await listNotificationsPage(db, { cursor, limit, needsYou });
    return c.json({ items: page.items.map(projectNotification), nextCursor: page.nextCursor });
  });

  app.post("/notifications/:id/read", async (c) => {
    const row = await markNotificationRead(db, c.req.param("id"));
    if (!row) return c.json({ error: "notification not found" }, 404);
    await broadcastNotifications(db);
    return c.json(projectNotification(row));
  });

  app.post("/notifications/read_all", async (c) => {
    const updated = await markAllNotificationsRead(db);
    await broadcastNotifications(db);
    return c.json({ updated });
  });

  app.get("/notifications/preferences", async (c) => c.json(await listNotificationPreferences(db)));

  app.patch("/notifications/preferences/:kind", async (c) => {
    const kindResult = NotificationKindSchema.safeParse(c.req.param("kind"));
    if (!kindResult.success) return c.json({ error: "unknown notification kind" }, 400);
    const body = await c.req.json().catch(() => undefined);
    const parsed = NotificationPreferenceUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json(await updateNotificationPreference(db, kindResult.data, parsed.data));
    } catch (error) {
      if (error instanceof ForcedChannelError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.get("/notifications/quiet_hours", async (c) => c.json(await getQuietHours(db)));

  app.patch("/notifications/quiet_hours", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = QuietHoursUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await updateQuietHours(db, parsed.data));
  });

  app.get("/push/config", async (c) => {
    const webPush = getSettings().webPush;
    return c.json({
      available: Boolean(webPush),
      publicKey: webPush?.publicKey ?? null,
      deviceCount: await countPushSubscriptions(db),
    });
  });

  app.post("/push/subscriptions", async (c) => {
    if (!getSettings().webPush) return c.json({ error: "Web Push is not configured" }, 503);
    const body = await c.req.json().catch(() => undefined);
    const parsed = PushSubscriptionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    await upsertPushSubscription(db, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent: c.req.header("user-agent")?.slice(0, 256) ?? null,
    });
    return c.json({ registered: true }, 201);
  });

  app.delete("/push/subscriptions", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = PushSubscriptionDeleteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    await deletePushSubscription(db, parsed.data.endpoint);
    return c.body(null, 204);
  });

  app.get("/digests", async (c) => {
    const personaId = c.req.query("personaId");
    return c.json(await listDigests(db, personaId));
  });

  app.get("/digests/:id", async (c) => {
    const digest = await getDigest(db, c.req.param("id"));
    if (!digest) return c.json({ error: "digest not found" }, 404);
    return c.json(digest);
  });

  // The write side of the digests table (createDigest, in digest-repo.ts)
  // had no caller before this — this route is that caller, generating one
  // on demand for a given persona rather than only ever guessing at a
  // scheduled routine's exact content (see digest-generator.ts's own
  // header comment for why that's deliberately out of scope here).
  app.post("/digests/generate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const personaId = typeof body.personaId === "string" ? body.personaId : undefined;
    if (!personaId) return c.json({ error: "personaId is required" }, 400);
    const push = typeof body.push === "boolean" ? body.push : undefined;

    try {
      const digest = await generateDigest(db, personaId, { push });
      return c.json(digest, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 404);
    }
  });

  return app;
}
