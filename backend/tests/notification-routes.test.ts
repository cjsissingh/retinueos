import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { notificationRoutes } from "../src/notifications/notification-routes.js";
import { insertNotification } from "../src/notifications/notification-repo.js";

const { db } = useTestDb();

describe("GET /notifications", () => {
  it("returns the public title/body/kind shape without internal delivery fields", async () => {
    await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "Wren finished." });
    const response = await notificationRoutes(db()).request("/notifications");
    const body = await response.json();

    expect(body.items[0]).toMatchObject({ kind: "job_finished", title: "Finished", body: "Wren finished." });
    expect(body.items[0]).not.toHaveProperty("message");
    expect(body.items[0]).not.toHaveProperty("urgent");
  });

  it("filters to needs_you=true", async () => {
    await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "a" });
    const failed = await insertNotification(db(), { kind: "job_failed", title: "Failed", message: "b" });
    const response = await notificationRoutes(db()).request("/notifications?needs_you=true");
    const body = await response.json();

    expect(body.items.map((notification: { id: string }) => notification.id)).toEqual([failed.id]);
  });
});

describe("POST notification read state", () => {
  it("marks one notification read", async () => {
    const row = await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "a" });
    const response = await notificationRoutes(db()).request(`/notifications/${row.id}/read`, { method: "POST" });

    expect(response.status).toBe(200);
    expect((await response.json()).readAt).not.toBeNull();
  });

  it("returns 404 for a missing notification", async () => {
    const response = await notificationRoutes(db()).request(`/notifications/${randomUUID()}/read`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("marks every unread notification read at once", async () => {
    await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "a" });
    await insertNotification(db(), { kind: "job_failed", title: "Failed", message: "b" });
    const response = await notificationRoutes(db()).request("/notifications/read_all", { method: "POST" });
    expect(await response.json()).toEqual({ updated: 2 });
  });
});
