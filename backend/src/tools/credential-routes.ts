import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import { storeCredential, hasCredential, deleteCredential } from "./credentials.js";
import { CredentialPayloadSchema } from "./credential-schemas.js";

/**
 * Never returns a stored secret — only whether one exists. Currently unused
 * by any built-in integration (hand-coded Gmail/Calendar tools were retired;
 * see docs/adr/0002-external-tools-via-mcp-adapters.md). MCP server
 * credentials go through mcp-server-repo.ts's own bearer_token / oauth
 * columns instead. Kept as the generic per-toolId credential store for any
 * future non-MCP integration that needs one.
 */
export function credentialRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.get("/credentials/:toolId", async (c) => {
    const configured = await hasCredential(db, c.req.param("toolId"));
    return c.json({ toolId: c.req.param("toolId"), configured });
  });

  app.post("/credentials/:toolId", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CredentialPayloadSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "expected a JSON object payload" }, 400);
    await storeCredential(db, c.req.param("toolId"), parsed.data);
    return c.json({ toolId: c.req.param("toolId"), configured: true }, 201);
  });

  app.delete("/credentials/:toolId", async (c) => {
    await deleteCredential(db, c.req.param("toolId"));
    return c.json({ toolId: c.req.param("toolId"), configured: false });
  });

  return app;
}
