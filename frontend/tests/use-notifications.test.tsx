import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { NotificationsProvider, useNotifications } from "../lib/use-notifications";
import type { NotificationRow } from "../lib/api-client";

function row(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "n1",
    kind: "job_failed",
    personaId: null,
    jobId: null,
    toolCallId: null,
    title: "Failed",
    body: "oops",
    createdAt: "2026-08-29T12:00:00.000Z",
    readAt: null,
    actedAt: null,
    ...overrides,
  };
}

function Probe() {
  const { unreadNeedsYouCount } = useNotifications();
  return <span>{unreadNeedsYouCount}</span>;
}

describe("useNotificationsLive's unread needs-you count", () => {
  it("counts only unread needs-you rows via NotificationsProvider's snapshot", () => {
    const items = [
      row({ id: "n1", kind: "job_failed", readAt: null }),
      row({ id: "n2", kind: "job_finished", readAt: null }),
    ];
    const markup = renderToStaticMarkup(
      <NotificationsProvider value={{ items, unreadNeedsYouCount: 1, revision: 1, ready: true }}>
        <Probe />
      </NotificationsProvider>,
    );
    expect(markup).toContain(">1<");
  });
});
