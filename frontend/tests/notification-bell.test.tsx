import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationBell } from "../components/notification-bell";
import { ApiClient } from "../lib/api-client";
import { NotificationsProvider } from "../lib/use-notifications";

const client = new ApiClient("http://example.test", () => null);

describe("NotificationBell badge", () => {
  it("shows the unread needs-you count", () => {
    const markup = renderToStaticMarkup(
      <NotificationsProvider value={{ items: [], unreadNeedsYouCount: 3, revision: 1, ready: true }}>
        <NotificationBell client={client} personas={[]} />
      </NotificationsProvider>,
    );
    expect(markup).toContain(">3<");
  });

  it("renders no badge at zero unread needs-you", () => {
    const markup = renderToStaticMarkup(
      <NotificationsProvider value={{ items: [], unreadNeedsYouCount: 0, revision: 1, ready: true }}>
        <NotificationBell client={client} personas={[]} />
      </NotificationsProvider>,
    );
    expect(markup).not.toContain("bg-warning");
  });

  it("labels the two filter chips per design guide", () => {
    const markup = renderToStaticMarkup(
      <NotificationsProvider value={{ items: [], unreadNeedsYouCount: 2, revision: 1, ready: true }}>
        <NotificationBell client={client} personas={[]} initiallyOpen />
      </NotificationsProvider>,
    );
    expect(markup).toContain("Needs you · 2");
    expect(markup).toContain(">All<");
    expect(markup).toContain("Mark all read");
    expect(markup).toContain("See all");
    expect(markup).toContain("Notification settings");
  });
});
