import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationsPageView } from "../components/notifications-page-view";
import { ApiClient } from "../lib/api-client";
import { NotificationsProvider } from "../lib/use-notifications";

const client = new ApiClient("http://example.test", () => null);

describe("/notifications route", () => {
  it("renders the caught-up empty state when there is nothing to show", () => {
    const markup = renderToStaticMarkup(
      <NotificationsProvider value={{ items: [], unreadNeedsYouCount: 0, revision: 1, ready: true }}>
        <NotificationsPageView client={client} items={[]} personas={[]} />
      </NotificationsProvider>,
    );
    expect(markup).toContain("Nothing needs your attention.");
  });

  it("titles the page Notifications", () => {
    const markup = renderToStaticMarkup(
      <NotificationsProvider value={{ items: [], unreadNeedsYouCount: 0, revision: 1, ready: true }}>
        <NotificationsPageView client={client} items={[]} personas={[]} />
      </NotificationsProvider>,
    );
    expect(markup).toContain("Notifications");
    expect(markup).toContain("Decisions, questions, and outcomes from across the house.");
  });
});
