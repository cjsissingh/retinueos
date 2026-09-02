import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpToolRow } from "@/app/settings/mcp/mcp-settings-content";
import type { McpServerTool } from "@/lib/api-client";

const tool: McpServerTool = {
  id: "tool-1",
  serverId: "server-1",
  toolName: "search_gmail_messages",
  description: "Search a mailbox using a Gmail query.",
  parametersSchema: {},
  version: "1",
  serverHintRiskClass: "read_only",
  riskClass: null,
  approved: false,
  discoveredAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("McpToolRow", () => {
  it("leads with a readable tool name and retains the raw name as metadata", () => {
    const markup = renderToStaticMarkup(
      <McpToolRow
        tool={tool}
        selected={false}
        onToggleSelected={() => {}}
        onApprove={async () => {}}
        onRevoke={async () => {}}
      />,
    );

    expect(markup).toContain("Search Gmail messages");
    expect(markup).toContain("search_gmail_messages");
    expect(markup.indexOf("Search Gmail messages")).toBeLessThan(markup.indexOf("search_gmail_messages"));
  });

  it("uses a checkbox for collection membership with a full touch target", () => {
    const markup = renderToStaticMarkup(
      <McpToolRow
        tool={tool}
        selected
        onToggleSelected={() => {}}
        onApprove={async () => {}}
        onRevoke={async () => {}}
      />,
    );

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("Select Search Gmail messages");
  });
});
