// backend/src/tools/mcp-server-repo.ts
//
// CRUD for mcp_servers and mcp_server_tools (see db/schema.ts's doc comments
// for the trust model). Bearer tokens are encrypted with credentials.ts's
// existing AES-256-GCM cipher on the way in and decrypted only when actually
// needed to call the server — never on a plain list/get.
import { createHash } from "node:crypto";
import { and, eq, gt, notInArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { mcpServers, mcpServerTools, type McpServerRow, type McpServerToolRow } from "../db/schema.js";
import { encrypt, decrypt } from "./credentials.js";
import { McpClientError, type McpToolDescriptor } from "./mcp-client.js";
// Imported as a namespace (rather than named imports) so that
// vi.spyOn(mcpOauth, "refreshAccessToken") in tests replaces the property
// this module reads through — Vitest's spy rewrites the exported binding
// on the namespace object, not a separately-bound local variable that a
// named import would have captured.
import * as mcpOauth from "./mcp-oauth.js";
import type { OAuthTokenResult } from "./mcp-oauth.js";
import type { RiskClass } from "./registry.js";

export interface McpServerCreateInput {
  name: string;
  url: string;
  authType?: "bearer" | "oauth";
  bearerToken?: string | null;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthAuthorizationEndpoint?: string;
  oauthTokenEndpoint?: string;
  oauthScope?: string;
}

export async function createMcpServer(db: DrizzleDb, input: McpServerCreateInput): Promise<McpServerRow> {
  const authType = input.authType ?? "bearer";
  const [row] = await db
    .insert(mcpServers)
    .values({
      name: input.name,
      url: input.url,
      authType,
      bearerToken: input.bearerToken ? encrypt(input.bearerToken) : null,
      oauthClientId: authType === "oauth" ? (input.oauthClientId ?? null) : null,
      oauthClientSecret: authType === "oauth" && input.oauthClientSecret ? encrypt(input.oauthClientSecret) : null,
      oauthAuthorizationEndpoint: authType === "oauth" ? (input.oauthAuthorizationEndpoint ?? null) : null,
      oauthTokenEndpoint: authType === "oauth" ? (input.oauthTokenEndpoint ?? null) : null,
      oauthScope: authType === "oauth" ? (input.oauthScope ?? null) : null,
    })
    .returning();
  if (!row) throw new Error("insert into mcp_servers returned no row");
  return row;
}

export async function listMcpServers(db: DrizzleDb): Promise<McpServerRow[]> {
  return db.select().from(mcpServers);
}

export async function getMcpServer(db: DrizzleDb, id: string): Promise<McpServerRow | undefined> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
  return row;
}

/** Decrypts the stored bearer token — only call this right before actually
 *  reaching out to the server, not for list/get display. */
export async function getMcpServerConnection(
  db: DrizzleDb,
  id: string,
): Promise<{ url: string; bearerToken?: string | null } | undefined> {
  const row = await getMcpServer(db, id);
  if (!row) return undefined;
  return { url: row.url, bearerToken: row.bearerToken ? decrypt(row.bearerToken) : null };
}

/** Starts (or restarts) the OAuth handshake for an oauth-authType server:
 *  mints a single-use state token, stores it with a 10-minute expiry, and
 *  returns the URL to send the browser to. Throws if the server isn't
 *  authType "oauth" or is missing its OAuth config — callers (the route
 *  layer) are expected to have already checked authType before calling. */
export async function startMcpServerOAuth(
  db: DrizzleDb,
  serverId: string,
  redirectUri: string,
): Promise<{ authorizeUrl: string }> {
  const server = await getMcpServer(db, serverId);
  if (
    !server ||
    server.authType !== "oauth" ||
    !server.oauthAuthorizationEndpoint ||
    !server.oauthClientId ||
    !server.oauthScope
  ) {
    throw new Error(`mcp server ${serverId} is not configured for OAuth`);
  }
  const state = mcpOauth.generateOAuthState();
  await db
    .update(mcpServers)
    .set({ oauthPendingState: state, oauthPendingStateExpiresAt: new Date(Date.now() + 10 * 60 * 1000) })
    .where(eq(mcpServers.id, serverId));
  const authorizeUrl = mcpOauth.buildAuthorizeUrl({
    authorizationEndpoint: server.oauthAuthorizationEndpoint,
    clientId: server.oauthClientId,
    redirectUri,
    scope: server.oauthScope,
    state,
  });
  return { authorizeUrl };
}

/** Atomically finds and single-use-consumes a pending OAuth state — the
 *  UPDATE...RETURNING clears the state in the same statement that reads
 *  it, so a replayed or concurrently-raced callback can never match the
 *  same state twice. Returns undefined for an unknown, already-consumed,
 *  or expired state. */
export async function consumeMcpServerOAuthState(db: DrizzleDb, state: string): Promise<McpServerRow | undefined> {
  const [row] = await db
    .update(mcpServers)
    .set({ oauthPendingState: null, oauthPendingStateExpiresAt: null })
    .where(and(eq(mcpServers.oauthPendingState, state), gt(mcpServers.oauthPendingStateExpiresAt, new Date())))
    .returning();
  return row;
}

/** Persists a token result from mcp-oauth.ts's exchange/refresh calls.
 *  `refreshToken` is only overwritten when the provider actually returned
 *  one — a refresh-grant response (and some re-consent responses) omit
 *  it, and that must never erase a still-valid, previously stored refresh
 *  token. */
export async function storeMcpServerOAuthTokens(
  db: DrizzleDb,
  serverId: string,
  tokens: OAuthTokenResult,
): Promise<void> {
  const patch: Partial<typeof mcpServers.$inferInsert> = {
    oauthAccessToken: encrypt(tokens.accessToken),
    oauthAccessTokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
  };
  if (tokens.refreshToken) patch.oauthRefreshToken = encrypt(tokens.refreshToken);
  await db.update(mcpServers).set(patch).where(eq(mcpServers.id, serverId));
}

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000;

/** Resolves a live connection for an oauth-authType server, refreshing the
 *  access token first if it's missing, expired, or within 60s of
 *  expiring. Called on every tool run and discovery pass for such servers
 *  — see mcp-registration.ts's buildMcpToolSpec — rather than once at
 *  registration time, since an OAuth access token is short-lived (unlike
 *  a static bearer token, which stays baked in at registration). */
export async function resolveMcpServerConnection(
  db: DrizzleDb,
  serverId: string,
  signal?: AbortSignal,
): Promise<{ url: string; bearerToken: string }> {
  const server = await getMcpServer(db, serverId);
  if (!server || server.authType !== "oauth") {
    throw new Error(`mcp server ${serverId} is not an OAuth server`);
  }
  if (!server.oauthRefreshToken) {
    throw new Error(`mcp server ${serverId} has not completed the OAuth handshake`);
  }
  if (!server.oauthTokenEndpoint || !server.oauthClientId || !server.oauthClientSecret) {
    throw new Error(
      `mcp server ${serverId} is missing OAuth configuration (oauthTokenEndpoint/oauthClientId/oauthClientSecret) despite having completed the handshake`,
    );
  }
  if (server.oauthAccessToken && server.oauthAccessTokenExpiresAt) {
    const freshEnough = server.oauthAccessTokenExpiresAt.getTime() - Date.now() > ACCESS_TOKEN_REFRESH_BUFFER_MS;
    if (freshEnough) return { url: server.url, bearerToken: decrypt(server.oauthAccessToken) };
  }
  let tokens: OAuthTokenResult;
  try {
    tokens = await mcpOauth.refreshAccessToken(
      {
        tokenEndpoint: server.oauthTokenEndpoint,
        clientId: server.oauthClientId,
        clientSecret: decrypt(server.oauthClientSecret),
        refreshToken: decrypt(server.oauthRefreshToken),
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new McpClientError("oauth_reauth_required", error);
  }
  await storeMcpServerOAuthTokens(db, serverId, tokens);
  return { url: server.url, bearerToken: tokens.accessToken };
}

export async function deleteMcpServer(db: DrizzleDb, id: string): Promise<void> {
  // mcp_server_tools cascades via the FK's ON DELETE CASCADE.
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}

export interface McpServerUpdateInput {
  enabled?: boolean;
  /** Rotating the URL or bearer token in place, instead of only through
   *  DELETE + re-create, matters because DELETE cascades and destroys every
   *  human-set tool approval with it (see db/schema.ts's ON DELETE CASCADE
   *  on mcp_server_tools) — a credential rotation shouldn't force redoing
   *  every approval decision. Doesn't itself trigger re-discovery; the route
   *  layer decides whether/when to kick that off separately. */
  url?: string;
  bearerToken?: string;
}

export async function updateMcpServer(
  db: DrizzleDb,
  id: string,
  input: McpServerUpdateInput,
): Promise<McpServerRow | undefined> {
  const patch: Partial<typeof mcpServers.$inferInsert> = {};
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.url !== undefined) patch.url = input.url;
  if (input.bearerToken !== undefined) patch.bearerToken = encrypt(input.bearerToken);
  if (Object.keys(patch).length === 0) return getMcpServer(db, id);
  const [row] = await db.update(mcpServers).set(patch).where(eq(mcpServers.id, id)).returning();
  return row;
}

/** Derives the untrusted pre-fill from a server's self-reported MCP
 *  annotations. Never used as the actual `riskClass` — only a human-set
 *  value in that column makes a tool callable; see db/schema.ts. */
function deriveHintRiskClass(descriptor: Pick<McpToolDescriptor, "readOnlyHint" | "destructiveHint">): RiskClass {
  if (descriptor.destructiveHint === true) return "destructive";
  if (descriptor.readOnlyHint === true) return "read_only";
  return "reversible";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- canonicalizes the MCP server's arbitrary JSON Schema value at its persistence boundary.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function mcpToolVersion(descriptor: Pick<McpToolDescriptor, "name" | "description" | "inputSchema">): string {
  return createHash("sha256").update(canonicalJson(descriptor)).digest("hex");
}

/** Upserts a discovery pass's tool catalog by (server_id, tool_name). New
 *  rows start unapproved with riskClass null. Existing rows have their
 *  description/schema/hint refreshed. Approval survives only when the
 *  deterministic content version is unchanged; changed executable contracts
 *  return to the human-confirmation gate. Rows absent from the new complete
 *  catalog are removed so withdrawn tools cannot remain callable — except
 *  when the new catalog is empty: an empty `tools/list` result could be a
 *  transient auth misconfiguration or a mid-deploy blip on the remote server
 *  rather than a deliberate "every tool was removed," and treating it as the
 *  latter would permanently destroy every human-set riskClass/approved
 *  decision for the server on a fluke. An empty descriptors array is
 *  therefore a no-op on existing rows (nothing to upsert, nothing to prune)
 *  — callers that need to represent "the server confirmed zero tools" as a
 *  deliberate state distinct from "discovery didn't return a usable answer"
 *  should do so explicitly rather than relying on this function to infer it
 *  from an empty array alone. */
export async function upsertDiscoveredTools(
  db: DrizzleDb,
  serverId: string,
  descriptors: McpToolDescriptor[],
): Promise<McpServerToolRow[]> {
  if (descriptors.length === 0) return [];
  return db.transaction(async (tx) => {
    const rows: McpServerToolRow[] = [];
    for (const descriptor of descriptors) {
      const version = mcpToolVersion(descriptor);
      const [row] = await tx
        .insert(mcpServerTools)
        .values({
          serverId,
          toolName: descriptor.name,
          description: descriptor.description,
          parametersSchema: descriptor.inputSchema,
          version,
          serverHintRiskClass: deriveHintRiskClass(descriptor),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [mcpServerTools.serverId, mcpServerTools.toolName],
          set: {
            description: descriptor.description,
            parametersSchema: descriptor.inputSchema,
            approved: sql<boolean>`case when ${mcpServerTools.version} = ${version} then ${mcpServerTools.approved} else false end`,
            riskClass: sql<
              string | null
            >`case when ${mcpServerTools.version} = ${version} then ${mcpServerTools.riskClass} else null end`,
            version,
            serverHintRiskClass: deriveHintRiskClass(descriptor),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row) rows.push(row);
    }
    // descriptors is non-empty here (the empty case returned above), so this
    // always prunes against a real, confirmed catalog — never wipes every
    // row as a side effect of an empty/failed discovery response.
    const names = descriptors.map((descriptor) => descriptor.name);
    await tx
      .delete(mcpServerTools)
      .where(and(eq(mcpServerTools.serverId, serverId), notInArray(mcpServerTools.toolName, names)));
    return rows;
  });
}

export async function listMcpServerTools(db: DrizzleDb, serverId: string): Promise<McpServerToolRow[]> {
  return db.select().from(mcpServerTools).where(eq(mcpServerTools.serverId, serverId));
}

export async function getMcpServerTool(
  db: DrizzleDb,
  serverId: string,
  toolId: string,
): Promise<McpServerToolRow | undefined> {
  const [row] = await db
    .select()
    .from(mcpServerTools)
    .where(and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.id, toolId)));
  return row;
}

/** All approved (riskClass set + approved: true), across every server —
 *  what registerMcpTools loads at startup. */
export async function listApprovedMcpServerTools(db: DrizzleDb): Promise<McpServerToolRow[]> {
  const rows = await db
    .select({ tool: mcpServerTools })
    .from(mcpServerTools)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerTools.serverId))
    .where(and(eq(mcpServerTools.approved, true), eq(mcpServers.enabled, true)));
  return rows.map(({ tool }) => tool);
}

export async function setMcpServerToolApproval(
  db: DrizzleDb,
  serverId: string,
  toolId: string,
  input: { riskClass?: RiskClass; approved: boolean },
): Promise<McpServerToolRow | undefined> {
  const patch = { approved: input.approved, updatedAt: new Date() } satisfies Partial<
    typeof mcpServerTools.$inferInsert
  >;
  if (input.riskClass) Object.assign(patch, { riskClass: input.riskClass });
  const [row] = await db
    .update(mcpServerTools)
    .set(patch)
    .where(and(eq(mcpServerTools.serverId, serverId), eq(mcpServerTools.id, toolId)))
    .returning();
  return row;
}
