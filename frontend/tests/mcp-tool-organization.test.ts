import { describe, expect, it } from "vitest";
import type { McpServer, McpServerTool } from "../lib/api-client";
import { mergeMcpToolUpdates, partitionMcpTools } from "../app/settings/mcp/mcp-settings-content";

const tool = (id: string, approved: boolean): McpServerTool => ({
  id,
  serverId: "server-1",
  toolName: id,
  description: "",
  parametersSchema: { type: "object" },
  version: "1",
  serverHintRiskClass: "read_only",
  riskClass: approved ? "read_only" : null,
  approved,
  discoveredAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
});

const server: McpServer = {
  id: "server-1",
  name: "Gmail",
  url: "https://example.com/mcp",
  authType: "bearer",
  enabled: true,
  createdAt: "2026-08-24T00:00:00.000Z",
  toolCount: 3,
  approvedCount: 1,
  oauthConnected: false,
};

describe("MCP tool organization", () => {
  it("separates tools that need review from approved tools", () => {
    const groups = partitionMcpTools([tool("search", false), tool("draft", true), tool("labels", false)]);

    expect(groups.needsReview.map(({ id }) => id)).toEqual(["search", "labels"]);
    expect(groups.approved.map(({ id }) => id)).toEqual(["draft"]);
  });

  it("merges approved tools and updates the server count locally", () => {
    const currentTools = [tool("search", false), tool("draft", true), tool("labels", false)];
    const result = mergeMcpToolUpdates([server], currentTools, [
      { ...tool("search", true), riskClass: "reversible" },
      { ...tool("labels", true), riskClass: "reversible" },
    ]);

    expect(result.servers[0]?.approvedCount).toBe(3);
    expect(result.tools.filter(({ approved }) => approved)).toHaveLength(3);
  });

  it("does not double-count a tool that was already approved", () => {
    const currentTools = [tool("draft", true)];
    const result = mergeMcpToolUpdates([server], currentTools, [{ ...tool("draft", true), riskClass: "destructive" }]);

    expect(result.servers[0]?.approvedCount).toBe(1);
  });
});
