import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationList, groupNotifications } from "../components/notification-list";
import { ApiClient, type NotificationRow } from "../lib/api-client";

const client = new ApiClient("http://example.test", () => null);
const NOW = new Date("2026-08-29T18:00:00.000Z");

function row(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "n1",
    kind: "job_finished",
    personaId: null,
    jobId: "job-1",
    toolCallId: null,
    title: "Finished",
    body: "done",
    createdAt: NOW.toISOString(),
    readAt: "2026-08-29T18:01:00.000Z",
    actedAt: null,
    ...overrides,
  };
}

describe("groupNotifications", () => {
  it("pins unacted needs-you rows regardless of age", () => {
    const pinned = row({
      id: "pinned",
      kind: "approval_needed",
      readAt: null,
      actedAt: null,
      createdAt: "2026-08-27T09:00:00.000Z",
    });
    const grouped = groupNotifications([pinned], NOW);
    expect(grouped.pinned.map((n) => n.id)).toEqual(["pinned"]);
  });

  it("puts today's acted/read rows in earlierToday and older ones in a day group", () => {
    const today = row({ id: "today", createdAt: "2026-08-29T09:00:00.000Z" });
    const older = row({ id: "older", createdAt: "2026-08-27T09:00:00.000Z" });
    const grouped = groupNotifications([today, older], NOW);
    expect(grouped.earlierToday.map((n) => n.id)).toEqual(["today"]);
    expect(grouped.days[0]?.items.map((n) => n.id)).toEqual(["older"]);
  });

  it("does not double-count an acted needs-you row as pinned", () => {
    const acted = row({ id: "acted", kind: "approval_needed", readAt: null, actedAt: "2026-08-29T17:00:00.000Z" });
    const grouped = groupNotifications([acted], NOW);
    expect(grouped.pinned).toEqual([]);
    expect(grouped.earlierToday.map((n) => n.id)).toEqual(["acted"]);
  });
});

describe("NotificationList", () => {
  it("shows the caught-up empty state when there are no items", () => {
    const markup = renderToStaticMarkup(
      <NotificationList client={client} items={[]} personas={[]} onActed={() => undefined} />,
    );
    expect(markup).toContain("Nothing needs your attention.");
  });

  it("renders a NEEDS YOU section only when there is a pinned row", () => {
    const markup = renderToStaticMarkup(
      <NotificationList
        client={client}
        items={[row({ kind: "approval_needed", readAt: null, actedAt: null })]}
        personas={[]}
        onActed={() => undefined}
      />,
    );
    expect(markup).toContain("NEEDS YOU");
  });

  it("omits the NEEDS YOU section when nothing is pinned", () => {
    const markup = renderToStaticMarkup(
      <NotificationList client={client} items={[row({})]} personas={[]} onActed={() => undefined} />,
    );
    expect(markup).not.toContain("NEEDS YOU");
  });

  it("keeps recent rows readable under the caught-up banner once needs-you are read", () => {
    const markup = renderToStaticMarkup(
      <NotificationList
        client={client}
        items={[row({ title: "Finished", readAt: NOW.toISOString() })]}
        personas={[]}
        onActed={() => undefined}
      />,
    );
    expect(markup).toContain("Nothing needs your attention.");
    expect(markup).toContain("Finished");
  });
});
