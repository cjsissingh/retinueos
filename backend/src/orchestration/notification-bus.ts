import { EventEmitter } from "node:events";
import type { DrizzleDb } from "../db/client.js";
import type { NotificationRow } from "../db/schema.js";
import { listNotificationsPage } from "../notifications/notification-repo.js";

const CHANNEL = "notifications";
const SNAPSHOT_SIZE = 50;

/** Workspace-wide notification snapshots for every connected centre surface. */
export class NotificationBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(items: NotificationRow[]): void {
    for (const listener of this.emitter.listeners(CHANNEL)) {
      try {
        listener(items);
      } catch (error) {
        console.error("NotificationBus listener failed:", error);
      }
    }
  }

  subscribe(handler: (items: NotificationRow[]) => void): () => void {
    this.emitter.on(CHANNEL, handler);
    return () => this.emitter.off(CHANNEL, handler);
  }
}

export const defaultNotificationBus = new NotificationBus();

export async function broadcastNotifications(
  db: DrizzleDb,
  bus: NotificationBus = defaultNotificationBus,
): Promise<void> {
  try {
    const page = await listNotificationsPage(db, { limit: SNAPSHOT_SIZE });
    bus.publish(page.items);
  } catch (error) {
    console.error("failed to broadcast notifications:", error);
  }
}
