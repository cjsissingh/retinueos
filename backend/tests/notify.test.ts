import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { randomUUID } from "node:crypto";
import { WebPushError } from "web-push";
import { notificationDeliveries, type NotificationRow } from "../src/db/schema.js";
import { resetSettingsCache } from "../src/config.js";
import { listNotificationDeliveries } from "../src/notifications/delivery-repo.js";
import {
  notify,
  toTeaser,
  listNotifications,
  buildPushPayload,
  waitingApprovalMessage,
  outcomeNotificationMessage,
  deliverNotification,
  releaseHeldApprovalPush,
} from "../src/notifications/notify.js";
import { countPushSubscriptions, upsertPushSubscription } from "../src/notifications/push-subscription-repo.js";
import { updateNotificationPreference } from "../src/notifications/notification-preference-repo.js";
import { insertNotification } from "../src/notifications/notification-repo.js";
import { updateQuietHours } from "../src/notifications/notification-quiet-hours-repo.js";

const { db } = useTestDb();

function enableWebPush() {
  process.env.VAPID_PUBLIC_KEY = "public-key";
  process.env.VAPID_PRIVATE_KEY = "private-key";
  process.env.VAPID_SUBJECT = "mailto:owner@example.com";
  resetSettingsCache();
}

function payloadRow(overrides: Partial<NotificationRow> & Pick<NotificationRow, "message">): NotificationRow {
  return {
    id: randomUUID(),
    personaId: randomUUID(),
    jobId: randomUUID(),
    urgent: false,
    delivered: false,
    waitingApproval: false,
    createdAt: new Date("2026-08-27T12:00:00.000Z"),
    ...overrides,
  };
}

describe("toTeaser", () => {
  it("passes short messages through unchanged", () => {
    expect(toTeaser("short")).toBe("short");
  });

  it("truncates to under 200 characters with an ellipsis", () => {
    const long = "x".repeat(250);
    const teaser = toTeaser(long);
    expect(teaser.length).toBeLessThanOrEqual(200);
    expect(teaser.endsWith("…")).toBe(true);
  });
});

describe("delivery matrix gating", () => {
  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetSettingsCache();
  });

  async function subscribe() {
    enableWebPush();
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "key-a",
      auth: "auth-a",
    });
  }

  it("skips push when the kind's preference is off", async () => {
    await subscribe();
    await updateNotificationPreference(db(), "job_finished", { pushEnabled: false });
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const row = await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "done" });

    const delivered = await deliverNotification(db(), row, { sendPush, now: new Date("2026-08-29T12:00:00") });

    expect(sendPush).not.toHaveBeenCalled();
    expect(delivered.delivered).toBe(false);
  });

  it("lets pushOverride force push through a disabled matrix channel", async () => {
    await subscribe();
    await updateNotificationPreference(db(), "job_finished", { pushEnabled: false });
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const row = await insertNotification(db(), {
      kind: "job_finished",
      title: "Finished",
      message: "done",
      pushOverride: true,
    });

    const delivered = await deliverNotification(db(), row, { sendPush, now: new Date("2026-08-29T12:00:00") });

    expect(sendPush).toHaveBeenCalledOnce();
    expect(delivered.delivered).toBe(true);
  });

  it("holds push during quiet hours", async () => {
    await subscribe();
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const row = await insertNotification(db(), { kind: "job_failed", title: "Failed", message: "oops" });

    const delivered = await deliverNotification(db(), row, { sendPush, now: new Date("2026-08-29T23:00:00") });

    expect(sendPush).not.toHaveBeenCalled();
    expect(delivered.delivered).toBe(false);
  });

  it("releases a held, still-unacted approval after quiet hours", async () => {
    await subscribe();
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const row = await insertNotification(db(), {
      kind: "approval_needed",
      title: "Approval needed",
      message: "needs you",
    });
    await deliverNotification(db(), row, { sendPush, now: new Date("2026-08-29T23:00:00") });

    const released = await releaseHeldApprovalPush(db(), { sendPush, now: new Date("2026-08-30T07:30:00") });

    expect(sendPush).toHaveBeenCalledOnce();
    expect(released.map((notification) => notification.id)).toEqual([row.id]);
  });

  it("does not release a delivered or currently held approval", async () => {
    await subscribe();
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const deliveredRow = await insertNotification(db(), {
      kind: "approval_needed",
      title: "Approval needed",
      message: "delivered",
    });
    await deliverNotification(db(), deliveredRow, { sendPush, now: new Date("2026-08-29T12:00:00") });
    expect(await releaseHeldApprovalPush(db(), { sendPush, now: new Date("2026-08-30T07:30:00") })).toEqual([]);

    const heldRow = await insertNotification(db(), {
      kind: "approval_needed",
      title: "Approval needed",
      message: "held",
    });
    await deliverNotification(db(), heldRow, { sendPush, now: new Date("2026-08-30T23:00:00") });
    expect(await releaseHeldApprovalPush(db(), { sendPush, now: new Date("2026-08-31T02:00:00") })).toEqual([]);
  });
});

describe("approval push copy", () => {
  it("names the persona and tool", () => {
    expect(waitingApprovalMessage("Alex", "send_email")).toBe("Alex is waiting for approval to use send_email.");
    expect(outcomeNotificationMessage({ personaName: "Alex", status: "waiting_approval", toolId: "send_email" })).toBe(
      "Alex is waiting for approval to use send_email.",
    );
  });

  it("describes settled outcomes without a nested status chain", () => {
    expect(outcomeNotificationMessage({ personaName: "Alex", status: "done", summary: "All clear." })).toBe(
      "Alex finished. All clear.",
    );
    expect(outcomeNotificationMessage({ personaName: "Alex", status: "failed", error: "provider exploded" })).toBe(
      "Alex failed: provider exploded.",
    );
  });

  it("builds a payload that opens the approvals view", () => {
    const jobId = randomUUID();
    const payload = buildPushPayload(
      payloadRow({
        jobId,
        message: waitingApprovalMessage("Dr. Smith", "mcp.gmail/send_email"),
        urgent: true,
        waitingApproval: true,
      }),
    );
    expect(payload).toMatchObject({
      title: "RetinueOS — approval needed",
      body: "Dr. Smith is waiting for approval to use mcp.gmail/send_email.",
      path: "/approvals",
    });
  });

  it("sends ordinary job completions back to that job's chat, not the activity log", () => {
    const jobId = randomUUID();
    const personaId = randomUUID();
    expect(
      buildPushPayload(payloadRow({ jobId, personaId, message: "Alex finished. The report is ready." })).path,
    ).toBe(`/roster/${personaId}?chat=${jobId}`);
  });

  it("falls back to the job log when a completion has no persona", () => {
    const jobId = randomUUID();
    expect(
      buildPushPayload(payloadRow({ jobId, personaId: null, message: "Alex finished. The report is ready." })).path,
    ).toBe(`/logs/${jobId}`);
  });

  it("does not treat a completion summary that mentions a pause as an approval alert", () => {
    const jobId = randomUUID();
    const personaId = randomUUID();
    const payload = buildPushPayload(
      payloadRow({
        jobId,
        personaId,
        message: outcomeNotificationMessage({
          personaName: "Alex",
          status: "done",
          summary: "Delegate is waiting for approval to use send_email.",
        }),
      }),
    );
    expect(payload).toMatchObject({
      title: "RetinueOS",
      body: "Alex finished. Delegate is waiting for approval to use send_email.",
      path: `/roster/${personaId}?chat=${jobId}`,
    });
  });
});

describe("notify", () => {
  const originalWebhook = process.env.NOTIFY_WEBHOOK_URL;
  const originalWebhookTimeout = process.env.NOTIFY_WEBHOOK_TIMEOUT_MS;
  // None of these tests are about quiet hours -- they're exercising webhook/
  // push delivery mechanics. But the default row (seeded lazily by
  // getQuietHours) is enabled 22:00-07:00 server-local time, and
  // pushAllowedForRow checks it before pushOverride, so without this,
  // real wall-clock `now` makes every push here silently vanish for 9
  // hours a day server-local -- reliably reproduced in CI (UTC), invisible
  // most of the time in a dev timezone west of UTC.
  beforeEach(async () => {
    await updateQuietHours(db(), { enabled: false });
  });
  afterEach(() => {
    if (originalWebhook === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
    else process.env.NOTIFY_WEBHOOK_URL = originalWebhook;
    if (originalWebhookTimeout === undefined) delete process.env.NOTIFY_WEBHOOK_TIMEOUT_MS;
    else process.env.NOTIFY_WEBHOOK_TIMEOUT_MS = originalWebhookTimeout;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetSettingsCache();
    vi.unstubAllGlobals();
  });

  it("always writes a durable notifications row, even with no transport configured", async () => {
    delete process.env.NOTIFY_WEBHOOK_URL;
    const row = await notify(db(), { message: "Delivery needs a signature today", urgent: true });
    expect(row.delivered).toBe(false);
    expect(row.urgent).toBe(true);

    const all = await listNotifications(db());
    expect(all.some((n) => n.id === row.id)).toBe(true);
  });

  it("marks delivered=true when the configured webhook responds ok", async () => {
    process.env.NOTIFY_WEBHOOK_URL = "https://example.invalid/notify";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const row = await notify(db(), { message: "hello" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(row.delivered).toBe(true);
  });

  it("stays delivered=false (without throwing) when the webhook fails", async () => {
    process.env.NOTIFY_WEBHOOK_URL = "https://example.invalid/notify";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const row = await notify(db(), { message: "hello" });
    expect(row.delivered).toBe(false);
  });

  it("bounds webhook delivery with a configurable timeout", async () => {
    process.env.NOTIFY_WEBHOOK_URL = "https://example.invalid/notify";
    process.env.NOTIFY_WEBHOOK_TIMEOUT_MS = "10";
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("expected a webhook abort signal");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );

    const row = await notify(db(), { message: "hello" });
    expect(row.delivered).toBe(false);
  });

  it("records successful delivery to every push subscription and the webhook", async () => {
    enableWebPush();
    process.env.NOTIFY_WEBHOOK_URL = "https://hooks.example.test/retinueos";
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "key-a",
      auth: "auth-a",
    });
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-b",
      p256dh: "key-b",
      auth: "auth-b",
    });
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const fetchWebhook = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));

    const row = await notify(
      db(),
      { message: "The report is ready", jobId: randomUUID(), pushOverride: true },
      { sendPush, fetch: fetchWebhook },
    );

    expect(row.delivered).toBe(true);
    expect((await listNotificationDeliveries(db(), row.id)).map((delivery) => delivery.transport).sort()).toEqual([
      "web_push",
      "web_push",
      "webhook",
    ]);
    expect(
      (await db().select().from(notificationDeliveries)).every((delivery) => delivery.status === "delivered"),
    ).toBe(true);
  });

  it("sends approval pushes that name the blocked tool and open /approvals", async () => {
    enableWebPush();
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "key-a",
      auth: "auth-a",
    });
    const sendPush = vi.fn().mockResolvedValue(undefined);
    const jobId = randomUUID();

    await notify(
      db(),
      {
        message: waitingApprovalMessage("Dr. Smith", "mcp.gmail/send_email"),
        urgent: true,
        waitingApproval: true,
        jobId,
      },
      { sendPush },
    );

    expect(sendPush).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push.example.test/device-a" }),
      expect.objectContaining({
        title: "RetinueOS — approval needed",
        body: "Dr. Smith is waiting for approval to use mcp.gmail/send_email.",
        path: "/approvals",
      }),
      expect.anything(),
    );
  });

  it("keeps successful devices delivered when another device fails", async () => {
    enableWebPush();
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "key-a",
      auth: "auth-a",
    });
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-b",
      p256dh: "key-b",
      auth: "auth-b",
    });
    const sendPush = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("provider unavailable"));

    const row = await notify(db(), { message: "finished", pushOverride: true }, { sendPush });

    expect(row.delivered).toBe(true);
    expect((await listNotificationDeliveries(db(), row.id)).map((delivery) => delivery.status).sort()).toEqual([
      "delivered",
      "failed",
    ]);
  });

  it("expires and removes a subscription rejected permanently by its provider", async () => {
    enableWebPush();
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "key-a",
      auth: "auth-a",
    });
    const gone = new WebPushError("subscription gone", 410, {}, "gone", "https://push.example.test/device-a");

    const row = await notify(
      db(),
      { message: "finished", pushOverride: true },
      { sendPush: vi.fn().mockRejectedValue(gone) },
    );

    expect(row.delivered).toBe(false);
    expect((await listNotificationDeliveries(db(), row.id))[0]).toMatchObject({ status: "expired" });
    expect(await countPushSubscriptions(db())).toBe(0);
  });
});
