import { describe, it, expect } from "vitest";
import { NEEDS_YOU_KINDS, isNeedsYou, KIND_LABELS } from "../lib/notification-kinds";
import type { NotificationRow } from "../lib/api-client";

function row(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "n1",
    kind: "job_finished",
    personaId: null,
    jobId: null,
    toolCallId: null,
    title: "Finished",
    body: "done",
    createdAt: "2026-08-29T12:00:00.000Z",
    readAt: null,
    actedAt: null,
    ...overrides,
  };
}

describe("NEEDS_YOU_KINDS", () => {
  it("is exactly the four kinds that put a number on the bell", () => {
    expect([...NEEDS_YOU_KINDS].sort()).toEqual(
      ["approval_needed", "connector_broke", "job_failed", "question"].sort(),
    );
  });
});

describe("isNeedsYou", () => {
  it("is true only for an unread needs-you kind", () => {
    expect(isNeedsYou(row({ kind: "job_failed", readAt: null }))).toBe(true);
    expect(isNeedsYou(row({ kind: "job_failed", readAt: "2026-08-29T12:05:00.000Z" }))).toBe(false);
    expect(isNeedsYou(row({ kind: "job_finished", readAt: null }))).toBe(false);
  });
});

describe("KIND_LABELS", () => {
  it("has a label for all six kinds", () => {
    expect(Object.keys(KIND_LABELS)).toHaveLength(6);
    expect(KIND_LABELS.approval_needed).toBe("Approval needed");
  });
});
