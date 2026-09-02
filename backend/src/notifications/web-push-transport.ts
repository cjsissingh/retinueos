import webPush from "web-push";
import type { WebPushSettings } from "../config.js";
import type { PushSubscriptionRow } from "../db/schema.js";

export interface PushPayload {
  title: string;
  body: string;
  notificationId: string;
  path: string;
}

export type SendWebPush = (
  subscription: PushSubscriptionRow,
  payload: PushPayload,
  settings: WebPushSettings,
) => Promise<void>;

export const sendWebPush: SendWebPush = async (subscription, payload, settings) => {
  await webPush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(payload),
    {
      vapidDetails: settings,
      TTL: 24 * 60 * 60,
      urgency: "normal",
    },
  );
};

export function webPushStatusCode(error: Error): number | undefined {
  return error instanceof webPush.WebPushError ? error.statusCode : undefined;
}
