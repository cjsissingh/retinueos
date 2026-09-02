import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createMcpServer, upsertDiscoveredTools, setMcpServerToolApproval } from "../src/tools/mcp-server-repo.js";
import { registerApprovedMcpTool, mcpToolId } from "../src/tools/mcp-registration.js";
import { ToolRegistry } from "../src/tools/registry.js";
import * as mcpServerRepo from "../src/tools/mcp-server-repo.js";

const { db } = useTestDb();

beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeApprovedOAuthTool() {
  const server = await createMcpServer(db(), {
    name: "OAuth server",
    url: "https://93.184.216.34/mcp",
    authType: "oauth",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthAuthorizationEndpoint: "https://93.184.216.34/authorize",
    oauthTokenEndpoint: "https://93.184.216.34/token",
    oauthScope: "scope-a",
  });
  const [row] = await upsertDiscoveredTools(db(), server.id, [
    { name: "safe_read", description: "read", inputSchema: { type: "object" }, readOnlyHint: true },
  ]);
  await setMcpServerToolApproval(db(), server.id, row!.id, { riskClass: "read_only", approved: true });
  const approvedRow = { ...row!, approved: true, riskClass: "read_only" as const };
  return { server, row: approvedRow };
}

describe("registerApprovedMcpTool with an OAuth server", () => {
  it("does not register a tool for a server that never completed OAuth", async () => {
    const { server, row } = await makeApprovedOAuthTool();
    const registry = new ToolRegistry();

    await registerApprovedMcpTool(db(), registry, server.id, row);

    expect(registry.has(mcpToolId(server.id, row.toolName))).toBe(false);
  });

  it("registers the tool once the server has a refresh token, and run() resolves a connection per call", async () => {
    const { server, row } = await makeApprovedOAuthTool();
    await mcpServerRepo.storeMcpServerOAuthTokens(db(), server.id, {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresInSeconds: 3600,
    });
    const registry = new ToolRegistry();
    const resolveSpy = vi.spyOn(mcpServerRepo, "resolveMcpServerConnection").mockResolvedValue({
      url: server.url,
      bearerToken: "at-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string };
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "f", version: "1" } }
            : { status: "ok" };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await registerApprovedMcpTool(db(), registry, server.id, row);
    const id = mcpToolId(server.id, row.toolName);
    expect(registry.has(id)).toBe(true);
    expect(registry.get(id).externalSideEffect).toBe(false);
    expect(resolveSpy).not.toHaveBeenCalled();

    await registry.get(id).run({});
    expect(resolveSpy).toHaveBeenCalledWith(db(), server.id, undefined);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
