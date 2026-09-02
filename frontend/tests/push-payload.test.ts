import { describe, expect, it } from "vitest";
import { parsePushPayload, safeNotificationPath } from "../lib/push-payload";

describe("push notification payloads", () => {
  it("falls back to generic visible copy for absent or malformed payloads", () => {
    expect(parsePushPayload(null)).toEqual({
      title: "RetinueOS",
      body: "RetinueOS has an update.",
      path: "/logs",
    });
    expect(parsePushPayload({ title: "", body: 42, path: "jobs/1" })).toEqual({
      title: "RetinueOS",
      body: "RetinueOS has an update.",
      path: "/logs",
    });
  });

  it("keeps valid notification fields and ignores unrelated data", () => {
    expect(
      parsePushPayload({
        title: "Task finished",
        body: "Research is ready.",
        path: "/logs/job-1",
        notificationId: "notification-1",
        secret: "ignored",
      }),
    ).toEqual({
      title: "Task finished",
      body: "Research is ready.",
      path: "/logs/job-1",
      notificationId: "notification-1",
    });
  });

  it("allows only relative same-origin destinations", () => {
    expect(safeNotificationPath("https://evil.test/logs/job-1", "https://retinueos.test")).toBe("/logs");
    expect(safeNotificationPath("//evil.test/logs/job-1", "https://retinueos.test")).toBe("/logs");
    expect(safeNotificationPath("/logs/job-1?tab=result", "https://retinueos.test")).toBe("/logs/job-1?tab=result");
    expect(safeNotificationPath(undefined, "https://retinueos.test")).toBe("/logs");
  });
});
