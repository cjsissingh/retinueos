import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityPillRow } from "../components/activity-pill.js";
import type { ActivityPill } from "../lib/activity-pill.js";
import type { ToolCall } from "../lib/api-client.js";

function pill(calls: ToolCall[]): ActivityPill {
  return {
    kind: "activity_pill",
    key: "pill-tc1",
    at: "2026-01-01T00:00:00.000Z",
    connector: "gmail",
    summary: "search gmail ×2",
    count: calls.length,
    calls,
  };
}

function toolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "tc1",
    jobId: "j1",
    callId: null,
    toolId: "gmail_search",
    riskClass: "read_only",
    arguments: { query: "invoices" },
    status: "executed",
    result: { summary: "3 matching messages" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ActivityPillRow", () => {
  it("renders collapsed by default, showing the connector, summary, and count -- not the detail", () => {
    const markup = renderToStaticMarkup(<ActivityPillRow pill={pill([toolCall({})])} />);
    expect(markup).toContain("Gmail");
    expect(markup).toContain("search gmail ×2");
    expect(markup).not.toContain("3 matching messages");
    expect(markup).toContain('aria-expanded="false"');
  });
});
