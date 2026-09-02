import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  vapidPublicKeyToUint8Array,
  type PushBrowserPort,
  type PushSubscriptionPort,
} from "../lib/push-enrollment";

function subscription(): PushSubscriptionPort {
  return {
    endpoint: "https://push.test/device",
    toJSON: () => ({ endpoint: "https://push.test/device", keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function browser(current: PushSubscriptionPort | null = null): PushBrowserPort {
  return {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
    registerServiceWorker: vi.fn().mockResolvedValue({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(current),
        subscribe: vi.fn().mockResolvedValue(subscription()),
      },
    }),
    getServiceWorkerRegistration: vi
      .fn()
      .mockResolvedValue(
        current
          ? { pushManager: { getSubscription: vi.fn().mockResolvedValue(current), subscribe: vi.fn() } }
          : undefined,
      ),
  };
}

function client() {
  return {
    getPushConfig: vi
      .fn()
      .mockResolvedValueOnce({ available: true, publicKey: "AQID", deviceCount: 0 })
      .mockResolvedValue({ available: true, publicKey: "AQID", deviceCount: 1 }),
    registerPushSubscription: vi.fn().mockResolvedValue({ registered: true }),
    deletePushSubscription: vi.fn().mockResolvedValue(undefined),
  };
}

describe("push enrollment", () => {
  beforeEach(() => {
    vi.stubGlobal("atob", (value: string) => Buffer.from(value, "base64").toString("binary"));
  });

  it("reports unsupported without touching the API", async () => {
    const api = client();
    await expect(enablePushOnThisDevice(api, null)).resolves.toEqual({ status: "unsupported" });
    expect(api.getPushConfig).not.toHaveBeenCalled();
  });

  it("does not subscribe when notification permission is denied", async () => {
    const api = client();
    const port = browser();
    port.requestPermission = vi.fn().mockResolvedValue("denied");
    await expect(enablePushOnThisDevice(api, port)).resolves.toEqual({ status: "denied" });
    expect(api.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("registers the worker, subscribes, and reports the new aggregate count", async () => {
    const api = client();
    const port = browser();
    await expect(enablePushOnThisDevice(api, port)).resolves.toEqual({ status: "enabled", deviceCount: 1 });
    expect(port.registerServiceWorker).toHaveBeenCalledWith("/sw.js");
    expect(api.registerPushSubscription).toHaveBeenCalledWith({
      endpoint: "https://push.test/device",
      keys: { p256dh: "p", auth: "a" },
    });
  });

  it("reuses an existing local subscription", async () => {
    const existing = subscription();
    const api = client();
    const port = browser(existing);
    await enablePushOnThisDevice(api, port);
    const registration = await port.registerServiceWorker("/sw.js");
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("rolls back a newly-created local subscription when backend registration fails", async () => {
    const api = client();
    api.registerPushSubscription.mockRejectedValue(new Error("backend unavailable"));
    const local = subscription();
    const port = browser();
    const registration = await port.registerServiceWorker("/sw.js");
    registration.pushManager.subscribe = vi.fn().mockResolvedValue(local);
    port.registerServiceWorker = vi.fn().mockResolvedValue(registration);

    await expect(enablePushOnThisDevice(api, port)).rejects.toThrow("backend unavailable");
    expect(local.unsubscribe).toHaveBeenCalledOnce();
  });

  it("removes the backend endpoint before unsubscribing this device", async () => {
    const existing = subscription();
    const api = client();
    const port = browser(existing);
    await expect(disablePushOnThisDevice(api, port)).resolves.toEqual({ status: "disabled", deviceCount: 0 });
    expect(api.deletePushSubscription).toHaveBeenCalledWith(existing.endpoint);
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
  });

  it("converts URL-safe unpadded VAPID base64", () => {
    expect([...vapidPublicKeyToUint8Array("-_8")]).toEqual([251, 255]);
  });
});
