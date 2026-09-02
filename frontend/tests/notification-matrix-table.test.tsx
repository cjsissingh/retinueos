import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationMatrixTable } from "../components/notification-matrix-table";
import type { NotificationPreference } from "../lib/api-client";

const PREFERENCES: NotificationPreference[] = [
  { kind: "approval_needed", inAppEnabled: true, pushEnabled: true, digestEnabled: false },
  { kind: "question", inAppEnabled: true, pushEnabled: true, digestEnabled: false },
  { kind: "job_finished", inAppEnabled: true, pushEnabled: false, digestEnabled: true },
  { kind: "job_failed", inAppEnabled: true, pushEnabled: true, digestEnabled: false },
  { kind: "routine_ran", inAppEnabled: false, pushEnabled: false, digestEnabled: true },
  { kind: "connector_broke", inAppEnabled: true, pushEnabled: true, digestEnabled: false },
];

describe("NotificationMatrixTable", () => {
  it("renders one row per kind with its label", () => {
    const markup = renderToStaticMarkup(
      <NotificationMatrixTable preferences={PREFERENCES} onChange={() => undefined} />,
    );
    expect(markup).toContain("Approval needed");
    expect(markup).toContain("Routine ran");
  });

  it("labels a forced channel as required instead of making it resemble an interactive switch", () => {
    const markup = renderToStaticMarkup(
      <NotificationMatrixTable preferences={PREFERENCES} onChange={() => undefined} />,
    );
    expect(markup).toContain("Required");
    expect(markup).not.toContain('disabled=""');
  });

  it("shows an em dash for a kind with no digest column", () => {
    const markup = renderToStaticMarkup(
      <NotificationMatrixTable preferences={PREFERENCES} onChange={() => undefined} />,
    );
    expect(markup).toContain("—");
  });

  it("renders each cell as a switch, not a checkbox -- design guide's toggles", () => {
    const markup = renderToStaticMarkup(
      <NotificationMatrixTable preferences={PREFERENCES} onChange={() => undefined} />,
    );
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-checked="false"');
  });

  it("renders a stacked mobile matrix and aligned desktop grid", () => {
    const markup = renderToStaticMarkup(
      <NotificationMatrixTable preferences={PREFERENCES} onChange={() => undefined} />,
    );
    expect(markup).toContain("sm:hidden");
    expect(markup).toContain('class="hidden grid-cols-');
    expect(markup).toContain("sm:grid");
    expect(markup).not.toContain("<table");
  });
});
