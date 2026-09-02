import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetSettingsCache } from "../src/config.js";
import { countPushSubscriptions } from "../src/notifications/push-subscription-repo.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();
const authHeaders = { "X-Auth-Password": "test-password" };

describe("push subscription routes", () => {
  beforeEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetSettingsCache();
  });

  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetSettingsCache();
  });

  it("keeps enrollment unavailable until the backend has complete VAPID configuration", async () => {
    const res = await createApp(undefined, db()).request("/push/config", { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, publicKey: null, deviceCount: 0 });
  });

  it("requires existing RetinueOS authentication", async () => {
    const res = await createApp(undefined, db()).request("/push/config");

    expect(res.status).toBe(401);
  });

  it("registers the same browser endpoint idempotently without exposing its keys", async () => {
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    resetSettingsCache();
    const app = createApp(undefined, db());
    const request = (p256dh: string) =>
      app.request("/push/subscriptions", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json", "user-agent": "Test Browser" },
        body: JSON.stringify({
          endpoint: "https://push.example.test/device-a",
          keys: { p256dh, auth: "auth-key" },
        }),
      });

    const first = await request("first-key");
    const second = await request("updated-key");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual({ registered: true });
    expect(await second.json()).toEqual({ registered: true });
    expect(await countPushSubscriptions(db())).toBe(1);
  });

  it("rejects malformed subscriptions without storing them", async () => {
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    resetSettingsCache();
    const app = createApp(undefined, db());

    const res = await app.request("/push/subscriptions", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://push.example.test/device-a", keys: { p256dh: "", auth: "a" } }),
    });

    expect(res.status).toBe(400);
    expect(await countPushSubscriptions(db())).toBe(0);
  });

  it("disables only the submitted browser endpoint", async () => {
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";
    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    resetSettingsCache();
    const app = createApp(undefined, db());
    const endpoint = "https://push.example.test/device-a";
    await app.request("/push/subscriptions", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    });

    const res = await app.request("/push/subscriptions", {
      method: "DELETE",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });

    expect(res.status).toBe(204);
    expect(await countPushSubscriptions(db())).toBe(0);
  });
});
