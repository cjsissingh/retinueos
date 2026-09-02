// backend/src/tools/mcp-registration.ts
//
// Turns an approved mcp_server_tools row into a ToolSpec and (de)registers
// it into a ToolRegistry — the adapter in
// docs/adr/0002-external-tools-via-mcp-adapters.md: whichever tier a tool
// comes from, it becomes one ToolSpec flowing through the same dispatch
// node. Nothing here executes a tool differently than any other ToolSpec;
// `run` just delegates to mcp-client.ts's callMcpTool.
import type { DrizzleDb } from "../db/client.js";
import type { McpServerRow, McpServerToolRow } from "../db/schema.js";
import * as mcpClient from "./mcp-client.js";
import { insertNotification, notificationTitle } from "../notifications/notification-repo.js";
import { deliverNotification } from "../notifications/notify.js";
import { getMcpServer, getMcpServerConnection, listApprovedMcpServerTools } from "./mcp-server-repo.js";
// resolveMcpServerConnection is called through this namespace import (rather
// than a named import) so that tests can vi.spyOn(mcpServerRepo,
// "resolveMcpServerConnection") and have the spy actually intercept the call
// made below — a named import binds a local reference that a spy on the
// namespace object doesn't reach.
import * as mcpServerRepo from "./mcp-server-repo.js";
import { ToolRegistry, type RiskClass, type ToolSpec } from "./registry.js";

/** A normal tool rejection is not evidence that its connector is broken. */
const CONNECTOR_BROKEN_CATEGORIES = new Set<mcpClient.McpClientErrorCategory>([
  "unsafe_destination",
  "unreachable",
  "remote_http",
  "invalid_response",
  "protocol",
  "response_too_large",
  "pagination",
  "oauth_reauth_required",
]);

/** `mcp:${serverId}:${toolName}` is the canonical registry, approval, and
 *  audit id. ToolRegistry gives it a provider-safe model-facing alias and
 *  resolves that alias back before dispatch. */
export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

/** Builds the ToolSpec for one approved row.
 *
 *  `connection` is the pre-resolved static bearer connection for an
 *  authType "bearer" server — baked in once at registration time, since
 *  a static bearer token doesn't expire (unchanged from before OAuth
 *  support existed). Pass `null` for an authType "oauth" server, whose
 *  connection is instead resolved fresh on *every* call via
 *  resolveMcpServerConnection (mcp-server-repo.ts), because an OAuth
 *  access token is short-lived and needs refreshing. */
export function buildMcpToolSpec(
  db: DrizzleDb,
  server: Pick<McpServerRow, "id" | "authType">,
  connection: { url: string; bearerToken?: string | null } | null,
  row: McpServerToolRow,
): ToolSpec {
  if (!row.riskClass) {
    throw new Error(`mcp_server_tools row ${row.id} has no riskClass set — cannot register an unapproved tool`);
  }
  // SAFETY: mcp_server_tools.risk_class is a bare `text` column (db/schema.ts
  // keeps it free of a tools/ dependency), but the only writer —
  // mcp-server-repo.ts's setMcpServerToolApproval, called only from
  // mcp-routes.ts's PATCH handler after validating against
  // McpServerToolUpdateSchema's z.enum(["read_only","reversible",
  // "destructive"]) — never stores anything else.
  const riskClass = row.riskClass as RiskClass;
  return {
    id: mcpToolId(server.id, row.toolName),
    riskClass,
    externalSideEffect: riskClass !== "read_only",
    description: row.description,
    parameters: row.parametersSchema,
    origin: "mcp",
    namespace: server.id,
    version: row.version,
    run: async (args, ctx) => {
      const resolved =
        server.authType === "oauth"
          ? await mcpServerRepo.resolveMcpServerConnection(db, server.id, ctx?.signal)
          : connection;
      if (!resolved) throw new Error(`mcp server ${server.id} has no usable connection`);
      try {
        return await mcpClient.callMcpTool(resolved, row.toolName, args, ctx?.signal);
      } catch (error) {
        if (error instanceof mcpClient.McpClientError && CONNECTOR_BROKEN_CATEGORIES.has(error.category)) {
          const notification = await insertNotification(db, {
            kind: "connector_broke",
            title: notificationTitle("connector_broke", row.toolName),
            message: `The ${row.toolName} connector stopped responding: ${error.message}`,
            personaId: ctx?.personaId ?? null,
            jobId: ctx?.jobId ?? null,
            urgent: true,
          });
          await deliverNotification(db, notification);
        }
        throw error;
      }
    },
  };
}

/** Registers (or re-registers) one already-approved row into `registry`.
 *  Requires `approved && riskClass` — the human-confirmation gate; callers
 *  that haven't checked this yet (the PATCH route) must check before
 *  calling. An oauth-authType server additionally requires a stored
 *  refresh token: a server that's never completed the OAuth handshake (or
 *  whose access was revoked) must not register at all, the same way a
 *  disabled server doesn't. */
export async function registerApprovedMcpTool(
  db: DrizzleDb,
  registry: ToolRegistry,
  serverId: string,
  row: McpServerToolRow,
): Promise<void> {
  if (!row.approved || !row.riskClass) return;
  const server = await getMcpServer(db, serverId);
  if (!server?.enabled) return;
  if (server.authType === "oauth") {
    if (!server.oauthRefreshToken) return;
    registry.register(buildMcpToolSpec(db, server, null, row));
    return;
  }
  const connection = await getMcpServerConnection(db, serverId);
  if (!connection) return;
  registry.register(buildMcpToolSpec(db, server, connection, row));
}

/** Startup load: every approved mcp_server_tools row across every server
 *  becomes a live ToolSpec. Called once from server.ts, alongside builtin.ts's
 *  import-time native registrations. */
export async function registerAllApprovedMcpTools(db: DrizzleDb, registry: ToolRegistry): Promise<void> {
  const rows = await listApprovedMcpServerTools(db);
  const serverCache = new Map<string, McpServerRow | undefined>();
  const connectionCache = new Map<string, { url: string; bearerToken?: string | null } | undefined>();
  for (const row of rows) {
    if (!serverCache.has(row.serverId)) {
      serverCache.set(row.serverId, await getMcpServer(db, row.serverId));
    }
    const server = serverCache.get(row.serverId);
    if (!server?.enabled || !row.riskClass) continue;
    if (server.authType === "oauth") {
      if (!server.oauthRefreshToken) continue;
      registry.register(buildMcpToolSpec(db, server, null, row));
      continue;
    }
    if (!connectionCache.has(row.serverId)) {
      connectionCache.set(row.serverId, await getMcpServerConnection(db, row.serverId));
    }
    const connection = connectionCache.get(row.serverId);
    if (!connection) continue;
    registry.register(buildMcpToolSpec(db, server, connection, row));
  }
}

/** Removes every tool registered under one server's namespace — used when a
 *  server is deleted, so `defaultRegistry` doesn't keep serving tools whose
 *  DB rows are gone. The FK cascade removes the server's mcp_server_tools
 *  rows too, but not a shared `credentials` table row — a bearer token lives
 *  inline on the mcp_servers row itself (see mcp-server-repo.ts), not in the
 *  credentials table, so it's deleted along with the server row directly,
 *  not via any cascade into credentials. */
export function unregisterMcpServer(registry: ToolRegistry, serverId: string): void {
  registry.unregisterNamespace(serverId);
}
