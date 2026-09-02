import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationRow } from "../components/notification-row";
import { ApiClient, type NotificationRow as NotificationRowType } from "../lib/api-client";

const client = new ApiClient("http://example.test", () => null);

function row(overrides: Partial<NotificationRowType>): NotificationRowType {
  return {
    id: "n1",
    kind: "job_finished",
    personaId: null,
    jobId: "job-1",
    toolCallId: null,
    title: "Finished",
    body: "Wren finished the overnight sweep.",
    createdAt: "2026-08-29T12:00:00.000Z",
    readAt: "2026-08-29T12:05:00.000Z",
    actedAt: null,
    ...overrides,
  };
}

describe("NotificationRow", () => {
  it("renders the title and body lines", () => {
    const markup = renderToStaticMarkup(
      <NotificationRow client={client} notification={row({})} onActed={() => undefined} />,
    );
    expect(markup).toContain("Finished");
    expect(markup).toContain("Wren finished the overnight sweep.");
  });

  it("shows inline Approve/Open only for an unacted approval_needed row with a toolCallId", () => {
    const markup = renderToStaticMarkup(
      <NotificationRow
        client={client}
        notification={row({
          kind: "approval_needed",
          toolCallId: "tc1",
          title: "Approval needed · sends mail",
          readAt: null,
        })}
        onActed={() => undefined}
      />,
    );
    expect(markup).toContain("Approve");
    expect(markup).toContain("Open");
  });

  it("points Open at the job's chat, not the activity log, when a persona is known", () => {
    const markup = renderToStaticMarkup(
      <NotificationRow
        client={client}
        notification={row({ kind: "approval_needed", toolCallId: "tc1", personaId: "persona-1", readAt: null })}
        onActed={() => undefined}
      />,
    );
    expect(markup).toContain('href="/roster/persona-1?chat=job-1"');
  });

  it("hides the inline actions once actedAt is set", () => {
    const markup = renderToStaticMarkup(
      <NotificationRow
        client={client}
        notification={row({ kind: "approval_needed", toolCallId: "tc1", actedAt: "2026-08-29T12:10:00.000Z" })}
        onActed={() => undefined}
      />,
    );
    expect(markup).not.toContain(">Approve<");
  });

  it("marks an unread row with an amber gutter dot", () => {
    const markup = renderToStaticMarkup(
      <NotificationRow client={client} notification={row({ readAt: null })} onActed={() => undefined} />,
    );
    expect(markup).toContain("bg-warning");
  });
});
