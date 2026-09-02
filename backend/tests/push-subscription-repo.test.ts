import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import {
  countPushSubscriptions,
  deletePushSubscription,
  listPushSubscriptions,
  upsertPushSubscription,
} from "../src/notifications/push-subscription-repo.js";

const { db } = useTestDb();

describe("push subscription repository", () => {
  it("updates device keys when the same endpoint subscribes again", async () => {
    await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "first-key",
      auth: "first-auth",
      userAgent: "First browser",
    });

    const updated = await upsertPushSubscription(db(), {
      endpoint: "https://push.example.test/device-a",
      p256dh: "second-key",
      auth: "second-auth",
      userAgent: "Second browser",
    });

    expect(await countPushSubscriptions(db())).toBe(1);
    expect(updated).toMatchObject({
      endpoint: "https://push.example.test/device-a",
      p256dh: "second-key",
      auth: "second-auth",
      userAgent: "Second browser",
    });
  });

  it("removes only the subscription with the requested endpoint", async () => {
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

    expect(await deletePushSubscription(db(), "https://push.example.test/device-a")).toBe(true);
    expect(await deletePushSubscription(db(), "https://push.example.test/missing")).toBe(false);
    expect((await listPushSubscriptions(db())).map((row) => row.endpoint)).toEqual([
      "https://push.example.test/device-b",
    ]);
  });
});
