import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface PushPayloadFixture {
  title: string;
  body: string;
  path: string;
  notificationId: string;
}

interface PushEventFixture {
  data: { json(): PushPayloadFixture };
  waitUntil(promise: Promise<void>): void;
}

interface FetchEventFixture {
  request: {
    method: string;
    headers: { get(name: string): string | null };
    url: string;
    mode: string;
  };
  respondWith(promise: Promise<Response>): void;
}

interface ActivateEventFixture {
  waitUntil(promise: Promise<void[]>): void;
}

interface NotificationClickEventFixture {
  notification: { data?: { path?: string }; close(): void };
  waitUntil(promise: Promise<void>): void;
}

type ServiceWorkerEventFixture =
  PushEventFixture | FetchEventFixture | ActivateEventFixture | NotificationClickEventFixture;

type ServiceWorkerListener = (event: ServiceWorkerEventFixture) => void;

interface ShownNotification {
  title: string;
  options: NotificationOptions;
}

function loadServiceWorker() {
  const listeners = new Map<string, ServiceWorkerListener>();
  const openedCacheNames: string[] = [];
  const shownNotifications: ShownNotification[] = [];
  const cachedResponse = new Response("cached");

  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self: {
      location: new URL("https://retinueos.test"),
      addEventListener(type: string, listener: ServiceWorkerListener) {
        listeners.set(type, listener);
      },
      registration: {
        async showNotification(title: string, options: NotificationOptions) {
          shownNotifications.push({ title, options });
        },
      },
      clients: {
        async matchAll() {
          return [];
        },
        async openWindow() {
          return undefined;
        },
      },
    },
    caches: {
      async open(name: string) {
        openedCacheNames.push(name);
        return {
          async match() {
            return cachedResponse;
          },
          async put() {
            return undefined;
          },
        };
      },
      async keys() {
        return [];
      },
      async delete() {
        return true;
      },
    },
    async fetch() {
      return new Response("fresh");
    },
    URL,
  });

  return { listeners, openedCacheNames, shownNotifications };
}

describe("service worker identity", () => {
  it("opens the versioned RetinueOS shell cache for an app-shell navigation", async () => {
    const worker = loadServiceWorker();
    const listener = worker.listeners.get("fetch");
    if (!listener) throw new Error("service worker did not register a fetch listener");
    let responsePromise: Promise<Response> | undefined;
    const event: FetchEventFixture = {
      request: {
        method: "GET",
        headers: { get: () => null },
        url: "https://retinueos.test/today",
        mode: "navigate",
      },
      respondWith(promise) {
        responsePromise = promise;
      },
    };

    listener(event);
    if (!responsePromise) throw new Error("service worker did not intercept an app-shell navigation");
    await responsePromise;

    expect(worker.openedCacheNames).toContain("retinueos-shell-v1");
  });

  it("names notification tags with the RetinueOS identity prefix", async () => {
    const worker = loadServiceWorker();
    const listener = worker.listeners.get("push");
    if (!listener) throw new Error("service worker did not register a push listener");
    let notificationPromise: Promise<void> | undefined;
    const event: PushEventFixture = {
      data: {
        json: () => ({
          title: "Finished",
          body: "The report is ready.",
          path: "/logs/job-1",
          notificationId: "notification-1",
        }),
      },
      waitUntil(promise) {
        notificationPromise = promise;
      },
    };

    listener(event);
    if (!notificationPromise) throw new Error("service worker did not wait for notification delivery");
    await notificationPromise;

    expect(worker.shownNotifications).toHaveLength(1);
    expect(worker.shownNotifications[0]?.options.tag).toBe("retinueos-notification-1");
  });
});
