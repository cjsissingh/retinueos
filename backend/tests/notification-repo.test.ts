import { describe, it, expect } from "vitest";
import { useTestDb } from "./setup/db.js";
import { notifications, notificationPreferences, notificationQuietHours } from "../src/db/schema.js";
import { createJob } from "../src/jobs/job-repo.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createToolCall } from "../src/tool-calls/tool-call-repo.js";
import {
  insertNotification,
  listNotificationsPage,
  markNotificationRead,
  markAllNotificationsRead,
  markNotificationActedByToolCallId,
  notificationTitle,
} from "../src/notifications/notification-repo.js";

const { db } = useTestDb();

describe("notifications schema", () => {
  it("accepts the new kind/title/toolCallId/readAt/actedAt/pushOverride columns", async () => {
    const [row] = await db()
      .insert(notifications)
      .values({
        kind: "approval_needed",
        title: "Approval needed · sends mail",
        message: "Wren wants to send a reply to Katherine Bell",
        pushOverride: true,
      })
      .returning();
    expect(row.kind).toBe("approval_needed");
    expect(row.title).toBe("Approval needed · sends mail");
    expect(row.readAt).toBeNull();
    expect(row.actedAt).toBeNull();
    expect(row.toolCallId).toBeNull();
  });

  it("rejects a kind outside the fixed 6-value set", async () => {
    // SAFETY: this test intentionally sends a value the DB check constraint
    // must reject -- casting past NotificationKind is the point of the test.
    // oxlint-disable-next-line anti-slop/no-unsafe-type-assertion
    const insert = db()
      .insert(notifications)
      .values({ kind: "not_a_real_kind" as never, message: "x" });
    await expect(insert).rejects.toThrow();
  });
});

describe("notification_preferences and notification_quiet_hours tables", () => {
  it("stores one preference row per kind and a singleton quiet-hours row", async () => {
    const [pref] = await db()
      .insert(notificationPreferences)
      .values({ kind: "job_finished", inAppEnabled: true, pushEnabled: false, digestEnabled: true })
      .returning();
    expect(pref.kind).toBe("job_finished");

    const [hours] = await db()
      .insert(notificationQuietHours)
      .values({ id: true, enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 })
      .returning();
    expect(hours.startMinute).toBe(1320);

    // The singleton check constraint: a second row with id=true conflicts on
    // the primary key, which is exactly the "exactly one row" guarantee.
    await expect(db().insert(notificationQuietHours).values({ id: true })).rejects.toThrow();
  });
});

describe("notificationTitle", () => {
  it("joins the kind label and a detail with an interpunct", () => {
    expect(notificationTitle("approval_needed", "sends mail")).toBe("Approval needed · sends mail");
    expect(notificationTitle("job_finished")).toBe("Finished");
  });
});

describe("insertNotification / listNotificationsPage", () => {
  it("writes a row with the given kind and returns it newest-first", async () => {
    const first = await insertNotification(db(), {
      kind: "job_finished",
      title: "Finished",
      message: "Wren finished.",
    });
    const second = await insertNotification(db(), { kind: "job_failed", title: "Failed", message: "Wren failed." });

    const page = await listNotificationsPage(db(), {});
    expect(page.items.map((notification) => notification.id)).toEqual([second.id, first.id]);
    expect(page.nextCursor).toBeNull();
  });

  it("filters to needs-you kinds with readAt null", async () => {
    await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "done" });
    const failed = await insertNotification(db(), { kind: "job_failed", title: "Failed", message: "oops" });

    const page = await listNotificationsPage(db(), { needsYou: true });
    expect(page.items.map((notification) => notification.id)).toEqual([failed.id]);
  });

  it("paginates with a cursor once past the page size", async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertNotification(db(), { kind: "job_finished", title: "Finished", message: `run ${index}` });
    }
    const firstPage = await listNotificationsPage(db(), { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    if (firstPage.nextCursor === null) throw new Error("expected another page");

    const secondPage = await listNotificationsPage(db(), { limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
  });
});

describe("read state", () => {
  it("marks one notification read, and read_all marks every unread row", async () => {
    const first = await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "a" });
    await insertNotification(db(), { kind: "job_failed", title: "Failed", message: "b" });

    const read = await markNotificationRead(db(), first.id);
    expect(read?.readAt).not.toBeNull();

    const updated = await markAllNotificationsRead(db());
    expect(updated).toBe(1);
    const page = await listNotificationsPage(db(), {});
    expect(page.items.every((notification) => notification.readAt !== null)).toBe(true);
  });

  it("marks actedAt by toolCallId", async () => {
    const persona = await createPersona(db(), {
      name: "Approver",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user", prompt: "approve this" });
    const toolCall = await createToolCall(db(), {
      jobId: job.id,
      toolId: "send_email",
      riskClass: "destructive",
      arguments: {},
    });
    const row = await insertNotification(db(), {
      kind: "approval_needed",
      title: "Approval needed",
      message: "needs you",
      toolCallId: toolCall.id,
    });
    const acted = await markNotificationActedByToolCallId(db(), toolCall.id);
    expect(acted?.id).toBe(row.id);
    expect(acted?.actedAt).not.toBeNull();
  });
});
