import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalItem } from "../components/approval-item";
import { ApiClient, type ToolCall } from "../lib/api-client";

const client = new ApiClient("http://example.test", () => null);

function call(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "tc1",
    jobId: "job-1",
    callId: null,
    toolId: "write_state",
    riskClass: "reversible",
    arguments: { key: "notes", content: "hello" },
    status: "pending_approval",
    result: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("ApprovalItem Always allow", () => {
  it("offers Always allow on a non-destructive Ask prompt", () => {
    const markup = renderToStaticMarkup(
      <ApprovalItem client={client} toolCall={call({})} onResolved={() => undefined} />,
    );
    expect(markup).toContain("Always allow");
    expect(markup).toContain("Always allow skips this prompt on later runs.");
  });

  it("does not offer Always allow for a destructive tool", () => {
    const markup = renderToStaticMarkup(
      <ApprovalItem
        client={client}
        toolCall={call({ toolId: "send_email", riskClass: "destructive", arguments: { to: "a@b.c", subject: "Hi" } })}
        onResolved={() => undefined}
      />,
    );
    expect(markup).not.toContain("Always allow");
    expect(markup).toContain("Both open a confirm step.");
  });
});

describe("ApprovalItem offline gating", () => {
  it("disables Approve, Deny, and Always allow while offline, with a reason", () => {
    const markup = renderToStaticMarkup(
      <ApprovalItem client={client} toolCall={call({})} onResolved={() => undefined} online={false} />,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("You&#x27;re offline");
    expect(markup).toContain("acting on a stale approval is a real change");
  });

  it("leaves the buttons enabled while online", () => {
    const markup = renderToStaticMarkup(
      <ApprovalItem client={client} toolCall={call({})} onResolved={() => undefined} online={true} />,
    );
    expect(markup).not.toContain('disabled=""');
  });
});
