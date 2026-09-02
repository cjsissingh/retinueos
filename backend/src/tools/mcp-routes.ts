import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import { getSettings } from "../config.js";
import { decrypt } from "./credentials.js";
import { discoverTools, publicMcpError } from "./mcp-client.js";
import { exchangeAuthorizationCode } from "./mcp-oauth.js";
import {
  createMcpServer,
  consumeMcpServerOAuthState,
  deleteMcpServer,
  getMcpServer,
  getMcpServerConnection,
  getMcpServerTool,
  listMcpServers,
  listMcpServerTools,
  resolveMcpServerConnection,
  setMcpServerToolApproval,
  startMcpServerOAuth,
  storeMcpServerOAuthTokens,
  updateMcpServer,
  upsertDiscoveredTools,
} from "./mcp-server-repo.js";
import { mcpToolId, registerApprovedMcpTool, unregisterMcpServer } from "./mcp-registration.js";
import { McpServerCreateSchema, McpServerToolUpdateSchema, McpServerUpdateSchema } from "./mcp-schemas.js";
import { defaultRegistry } from "./registry.js";

function oauthRedirectUri(): string {
  return `${getSettings().backendUrl}/oauth/callback`;
}

function publicServer(server: Awaited<ReturnType<typeof createMcpServer>>) {
  const {
    bearerToken: _bearerToken,
    oauthClientSecret: _oauthClientSecret,
    oauthRefreshToken,
    oauthAccessToken: _oauthAccessToken,
    oauthPendingState: _oauthPendingState,
    ...safe
  } = server;
  return { ...safe, oauthConnected: Boolean(oauthRefreshToken) };
}

/**
 * Remote MCP connection routes — see docs/adr/0002-external-tools-via-mcp-adapters.md.
 * Adding a server never makes its tools callable by itself: discovery only
 * populates mcp_server_tools rows with an untrusted hint-derived default; a
 * tool becomes usable only after PATCH .../tools/:toolId sets riskClass +
 * approved: true, which is also the only place a tool gets registered into
 * defaultRegistry post-startup.
 */
export function mcpRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.post("/mcp/servers", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = McpServerCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const server = await createMcpServer(db, parsed.data);

    if (parsed.data.authType === "oauth") {
      // No discovery yet — nothing to authenticate a tools/list call with
      // until the human completes the handshake via .../oauth/start.
      return c.json({ server: publicServer(server), discovery: { ok: false, errorCategory: "not_connected" } }, 201);
    }

    // A discovery hiccup must not block adding the server config at all —
    // the human can retry discovery later via POST .../discover. Still
    // return 201 either way, with the discovery outcome alongside it.
    try {
      const descriptors = await discoverTools({ url: server.url, bearerToken: parsed.data.bearerToken ?? null });
      const tools = await upsertDiscoveredTools(db, server.id, descriptors);
      return c.json({ server: publicServer(server), discovery: { ok: true, toolCount: tools.length } }, 201);
    } catch (err) {
      return c.json({ server: publicServer(server), discovery: { ok: false, ...publicMcpError(err) } }, 201);
    }
  });

  app.post("/mcp/servers/:id/oauth/start", async (c) => {
    const id = c.req.param("id");
    const server = await getMcpServer(db, id);
    if (!server) return c.json({ error: "server not found" }, 404);
    if (server.authType !== "oauth") return c.json({ error: "server is not configured for OAuth" }, 400);
    try {
      const { authorizeUrl } = await startMcpServerOAuth(db, id, oauthRedirectUri());
      return c.json({ authorizeUrl });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not start OAuth" }, 400);
    }
  });

  app.get("/mcp/servers", async (c) => {
    const servers = await listMcpServers(db);
    const withCounts = await Promise.all(
      servers.map(async (server) => {
        const tools = await listMcpServerTools(db, server.id);
        return {
          ...publicServer(server),
          toolCount: tools.length,
          approvedCount: tools.filter((t) => t.approved).length,
        };
      }),
    );
    return c.json(withCounts);
  });

  app.get("/mcp/tools", async (c) => {
    const servers = await listMcpServers(db);
    const catalog = (
      await Promise.all(
        servers.map(async (server) =>
          !server.enabled
            ? []
            : (await listMcpServerTools(db, server.id))
                .filter((tool) => tool.approved && tool.riskClass)
                .map((tool) => ({
                  id: mcpToolId(server.id, tool.toolName),
                  label: tool.toolName,
                  sourceName: server.name,
                  riskClass: tool.riskClass,
                })),
        ),
      )
    ).flat();
    return c.json(catalog);
  });

  app.patch("/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = McpServerUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const server = await updateMcpServer(db, id, parsed.data);
    if (!server) return c.json({ error: "server not found" }, 404);

    // Re-registering unconditionally (not just when `enabled` changed) means
    // a url/bearerToken rotation also takes effect immediately: every
    // already-approved tool re-reads its connection fresh via
    // registerApprovedMcpTool -> getMcpServerConnection.
    unregisterMcpServer(defaultRegistry, id);
    if (server.enabled) {
      for (const tool of await listMcpServerTools(db, id)) {
        await registerApprovedMcpTool(db, defaultRegistry, id, tool);
      }
    }
    return c.json(publicServer(server));
  });

  app.post("/mcp/servers/:id/discover", async (c) => {
    const id = c.req.param("id");
    const server = await getMcpServer(db, id);
    if (!server) return c.json({ error: "server not found" }, 404);

    try {
      const connection =
        server.authType === "oauth" ? await resolveMcpServerConnection(db, id) : await getMcpServerConnection(db, id);
      if (!connection) return c.json({ error: "server not found" }, 404);
      const descriptors = await discoverTools(connection);
      const tools = await upsertDiscoveredTools(db, id, descriptors);
      // An empty discovery result is a no-op on stored rows (see
      // upsertDiscoveredTools's doc comment — could be a transient blip, not
      // a deliberate "every tool was removed"), so it must also be a no-op
      // on the live registry: churning defaultRegistry here would drop every
      // already-approved MCP tool from live dispatch over the same fluke,
      // even though nothing changed in the DB.
      if (descriptors.length > 0) {
        // Replace the live namespace from the authoritative refreshed
        // catalog: removed tools stop being callable, while still-approved
        // returned tools pick up refreshed descriptions and schemas
        // immediately.
        unregisterMcpServer(defaultRegistry, id);
        for (const tool of tools) await registerApprovedMcpTool(db, defaultRegistry, id, tool);
      }
      return c.json({ ok: true, toolCount: tools.length });
    } catch (err) {
      return c.json({ ok: false, ...publicMcpError(err) }, 502);
    }
  });

  app.get("/mcp/servers/:id/tools", async (c) => {
    const id = c.req.param("id");
    const server = await getMcpServer(db, id);
    if (!server) return c.json({ error: "server not found" }, 404);
    return c.json(await listMcpServerTools(db, id));
  });

  app.patch("/mcp/servers/:id/tools/:toolId", async (c) => {
    const id = c.req.param("id");
    const toolId = c.req.param("toolId");
    const body = await c.req.json().catch(() => null);
    const parsed = McpServerToolUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const existing = await getMcpServerTool(db, id, toolId);
    if (!existing) return c.json({ error: "tool not found" }, 404);

    const approved = parsed.data.approved ?? existing.approved;
    const riskClass = parsed.data.riskClass ?? existing.riskClass;
    // The human-confirmation gate: approving requires a riskClass to exist,
    // either freshly set here or already stored — never inferred from the
    // server's own hints. See db/schema.ts's mcp_server_tools comment.
    if (approved && !riskClass) {
      return c.json({ error: "approved: true requires riskClass to be set" }, 400);
    }

    const updated = await setMcpServerToolApproval(db, id, toolId, { riskClass: parsed.data.riskClass, approved });
    if (!updated) return c.json({ error: "tool not found" }, 404);

    if (updated.approved && updated.riskClass) {
      await registerApprovedMcpTool(db, defaultRegistry, id, updated);
    } else {
      defaultRegistry.unregister(mcpToolId(id, updated.toolName));
    }

    return c.json(updated);
  });

  app.delete("/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    const server = await getMcpServer(db, id);
    if (!server) return c.json({ error: "server not found" }, 404);
    await deleteMcpServer(db, id); // cascades to mcp_server_tools rows
    unregisterMcpServer(defaultRegistry, id);
    return c.json({ status: "deleted" });
  });

  /**
   * Google's (or any OAuth provider's) redirect target. Deliberately at
   * this exact top-level path — NOT `/mcp/oauth/callback` — so app.ts's
   * `app.use("/mcp/*", requireAuth())` never matches it: this is a plain
   * browser navigation and cannot carry the app's X-Auth-Password header.
   * Its actual CSRF protection is the single-use, 10-minute
   * oauthPendingState token consumed below. Never renders an error to the
   * browser — every failure path redirects back to the frontend with
   * ?oauth_error=<code> instead.
   */
  app.get("/oauth/callback", async (c) => {
    const frontendOrigin = getSettings().frontendOrigin;
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.redirect(`${frontendOrigin}/settings/mcp?oauth_error=invalid_state`, 302);

    let server;
    try {
      server = await consumeMcpServerOAuthState(db, state);
    } catch {
      // A DB failure while looking up the state is indistinguishable from
      // "state not found" to the caller — reuse the same error code rather
      // than letting a transient DB error propagate uncaught (there's no
      // app.onError fallback in app.ts, so an uncaught throw here would
      // surface Hono's raw 500 to the browser instead of redirecting).
      return c.redirect(`${frontendOrigin}/settings/mcp?oauth_error=invalid_state`, 302);
    }
    if (!server || !server.oauthTokenEndpoint || !server.oauthClientId || !server.oauthClientSecret) {
      return c.redirect(`${frontendOrigin}/settings/mcp?oauth_error=invalid_state`, 302);
    }

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        tokenEndpoint: server.oauthTokenEndpoint,
        clientId: server.oauthClientId,
        clientSecret: decrypt(server.oauthClientSecret),
        code,
        redirectUri: oauthRedirectUri(),
      });
    } catch {
      return c.redirect(`${frontendOrigin}/settings/mcp?oauth_error=token_exchange_failed`, 302);
    }

    try {
      await storeMcpServerOAuthTokens(db, server.id, tokens);
    } catch {
      // The token exchange itself succeeded — the OAuth provider isn't at
      // fault here, RetinueOS's own DB write failed. Distinct code from
      // token_exchange_failed so the two are distinguishable if the human
      // reports the error.
      return c.redirect(`${frontendOrigin}/settings/mcp?oauth_error=storage_failed`, 302);
    }

    // Populate the tool catalog immediately so there's no separate manual
    // "re-discover" click right after connecting — same call the static-
    // token creation path makes. A discovery hiccup here doesn't undo the
    // connection; the human can retry from the server list either way.
    try {
      const descriptors = await discoverTools({ url: server.url, bearerToken: tokens.accessToken });
      const tools = await upsertDiscoveredTools(db, server.id, descriptors);
      if (descriptors.length > 0) {
        unregisterMcpServer(defaultRegistry, server.id);
        for (const tool of tools) await registerApprovedMcpTool(db, defaultRegistry, server.id, tool);
      }
    } catch {
      // Swallow — the connection itself still succeeded.
    }

    return c.redirect(`${frontendOrigin}/settings/mcp?connected=${server.id}`, 302);
  });

  return app;
}
