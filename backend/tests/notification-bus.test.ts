import { describe, expect, it } from "vitest";
import type { NotificationRow } from "../src/db/schema.js";
import { useTestDb } from "./setup/db.js";
import { insertNotification } from "../src/notifications/notification-repo.js";
import { broadcastNotifications, NotificationBus } from "../src/orchestration/notification-bus.js";

const { db } = useTestDb();

function notificationFixture(): NotificationRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    personaId: null,
    jobId: null,
    toolCallId: null,
    kind: "job_finished",
    title: "Finished",
    message: "done",
    urgent: false,
    waitingApproval: false,
    delivered: false,
    pushOverride: null,
    readAt: null,
    actedAt: null,
    createdAt: new Date("2026-08-29T12:00:00Z"),
  };
}

describe("NotificationBus", () => {
  it("delivers a published snapshot to every subscriber", () => {
    const bus = new NotificationBus();
    const first: NotificationRow[][] = [];
    const second: NotificationRow[][] = [];
    const unsubscribe = bus.subscribe((items) => first.push(items));
    bus.subscribe((items) => second.push(items));

    bus.publish([notificationFixture()]);

    expect(first[0]?.[0]?.message).toBe("done");
    expect(second[0]?.[0]?.message).toBe("done");
    unsubscribe();
  });

  it("isolates one throwing listener from the rest", () => {
    const bus = new NotificationBus();
    const received: NotificationRow[][] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((items) => received.push(items));

    expect(() => bus.publish([])).not.toThrow();
    expect(received).toEqual([[]]);
  });
});

describe("broadcastNotifications", () => {
  it("re-reads and publishes the current snapshot", async () => {
    const bus = new NotificationBus();
    const received: NotificationRow[][] = [];
    bus.subscribe((items) => received.push(items));
    await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "done" });

    await broadcastNotifications(db(), bus);

    expect(received).toHaveLength(1);
    expect(received[0]?.[0]?.message).toBe("done");
  });
});
