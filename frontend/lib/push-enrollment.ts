import type { PushConfig, PushSubscriptionPayload } from "./api-client";

export interface PushSubscriptionPort {
  endpoint: string;
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

interface PushManagerPort {
  getSubscription(): Promise<PushSubscriptionPort | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: BufferSource }): Promise<PushSubscriptionPort>;
}

interface ServiceWorkerRegistrationPort {
  pushManager: PushManagerPort;
}

export interface PushBrowserPort {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  registerServiceWorker(path: string): Promise<ServiceWorkerRegistrationPort>;
  getServiceWorkerRegistration(): Promise<ServiceWorkerRegistrationPort | undefined>;
}

export interface PushEnrollmentClient {
  getPushConfig(): Promise<PushConfig>;
  registerPushSubscription(subscription: PushSubscriptionPayload): Promise<{ registered: true }>;
  deletePushSubscription(endpoint: string): Promise<void>;
}

export type PushEnrollmentResult =
  { status: "enabled" | "disabled"; deviceCount: number } | { status: "denied" | "unsupported" | "unavailable" };

export function vapidPublicKeyToUint8Array(publicKey: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = `${publicKey}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function subscriptionPayload(subscription: PushSubscriptionPort): PushSubscriptionPayload {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("The browser returned an incomplete push subscription.");
  return { endpoint, keys: { p256dh, auth } };
}

export function getPushBrowser(): PushBrowserPort | null {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return null;
  }

  return {
    get permission() {
      return Notification.permission;
    },
    requestPermission: () => Notification.requestPermission(),
    registerServiceWorker: (path) => navigator.serviceWorker.register(path),
    getServiceWorkerRegistration: () => navigator.serviceWorker.getRegistration(),
  };
}

export async function enablePushOnThisDevice(
  client: PushEnrollmentClient,
  browser: PushBrowserPort | null = getPushBrowser(),
): Promise<PushEnrollmentResult> {
  if (!browser) return { status: "unsupported" };
  const config = await client.getPushConfig();
  if (!config.available || !config.publicKey) return { status: "unavailable" };

  const registration = await browser.registerServiceWorker("/sw.js");
  const permission = browser.permission === "default" ? await browser.requestPermission() : browser.permission;
  if (permission !== "granted") return { status: "denied" };

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidPublicKeyToUint8Array(config.publicKey),
    }));
  try {
    await client.registerPushSubscription(subscriptionPayload(subscription));
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }

  const refreshed = await client.getPushConfig();
  return { status: "enabled", deviceCount: refreshed.deviceCount };
}

export async function disablePushOnThisDevice(
  client: PushEnrollmentClient,
  browser: PushBrowserPort | null = getPushBrowser(),
): Promise<PushEnrollmentResult> {
  if (!browser) return { status: "unsupported" };
  const registration = await browser.getServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await client.deletePushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }
  const refreshed = await client.getPushConfig();
  return { status: "disabled", deviceCount: refreshed.deviceCount };
}
