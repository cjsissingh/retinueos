import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerToolRow } from "../src/db/schema.js";
import { useTestDb } from "./setup/db.js";
import { listNotificationsPage } from "../src/notifications/notification-repo.js";
import { McpClientError } from "../src/tools/mcp-client.js";
import * as mcpClient from "../src/tools/mcp-client.js";
import { buildMcpToolSpec } from "../src/tools/mcp-registration.js";

const { db } = useTestDb();

const row: McpServerToolRow = {
  id: randomUUID(),
  serverId: randomUUID(),
  toolName: "search",
  description: "search",
  parametersSchema: {},
  version: "1",
  serverHintRiskClass: null,
  riskClass: "read_only",
  approved: true,
  discoveredAt: new Date(),
  updatedAt: new Date(),
};

afterEach(() => vi.restoreAllMocks());

describe("connector_broke notification", () => {
  it("writes a connector_broke row when the MCP call is unreachable", async () => {
    vi.spyOn(mcpClient, "callMcpTool").mockRejectedValue(new McpClientError("unreachable", new Error("ECONNREFUSED")));
    const spec = buildMcpToolSpec(
      db(),
      { id: row.serverId, authType: "bearer" },
      { url: "https://mcp.example.test" },
      row,
    );

    await expect(
      spec.run({}, { personaId: randomUUID(), jobId: randomUUID(), toolCallId: randomUUID(), db: db() }),
    ).rejects.toThrow(McpClientError);

    const page = await listNotificationsPage(db(), {});
    expect(page.items[0]).toMatchObject({ kind: "connector_broke", title: "Connector broke · search" });
  });

  it("does not write a connector_broke row for an ordinary tool failure", async () => {
    vi.spyOn(mcpClient, "callMcpTool").mockRejectedValue(
      new McpClientError("tool_failure", undefined, { isError: true }),
    );
    const spec = buildMcpToolSpec(
      db(),
      { id: row.serverId, authType: "bearer" },
      { url: "https://mcp.example.test" },
      row,
    );

    await expect(
      spec.run({}, { personaId: randomUUID(), jobId: randomUUID(), toolCallId: randomUUID(), db: db() }),
    ).rejects.toThrow(McpClientError);

    const page = await listNotificationsPage(db(), {});
    expect(page.items).toEqual([]);
  });
});
