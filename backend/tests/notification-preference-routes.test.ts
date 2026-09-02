import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { notificationRoutes } from "../src/notifications/notification-routes.js";

const { db } = useTestDb();

describe("notification preference routes", () => {
  it("seeds and returns all six kinds", async () => {
    const response = await notificationRoutes(db()).request("/notifications/preferences");
    const rows = await response.json();
    expect(rows).toHaveLength(6);
  });

  it("updates a togglable channel", async () => {
    const response = await notificationRoutes(db()).request("/notifications/preferences/job_finished", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushEnabled: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).pushEnabled).toBe(true);
  });

  it("rejects forced-channel changes and unknown kinds", async () => {
    const app = notificationRoutes(db());
    const forced = await app.request("/notifications/preferences/approval_needed", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inAppEnabled: false }),
    });
    const unknown = await app.request("/notifications/preferences/not_a_kind", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushEnabled: true }),
    });
    expect(forced.status).toBe(400);
    expect(unknown.status).toBe(400);
  });
});

describe("quiet-hours routes", () => {
  it("reads and writes the singleton window", async () => {
    const app = notificationRoutes(db());
    expect(await (await app.request("/notifications/quiet_hours")).json()).toMatchObject({
      enabled: true,
      startMinute: 1320,
      endMinute: 420,
    });
    const updated = await app.request("/notifications/quiet_hours", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startMinute: 1380, endMinute: 360 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ startMinute: 1380, endMinute: 360 });
  });

  it("rejects minute values outside one day", async () => {
    const response = await notificationRoutes(db()).request("/notifications/quiet_hours", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startMinute: 1500 }),
    });
    expect(response.status).toBe(400);
  });
});
