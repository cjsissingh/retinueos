import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import {
  createCustomTool,
  createCustomToolVersion,
  listCustomTools,
  listCustomToolVersions,
  reviewCustomToolVersion,
} from "./custom-tool-repo.js";
import {
  CustomToolCreateSchema,
  CustomToolReviewSchema,
  CustomToolVersionCreateSchema,
} from "./custom-tool-schemas.js";

/**
 * Custom-script proposal and review routes.
 * Existence approval only: nothing here executes a script or registers a
 * ToolSpec. Approving a version only marks it eligible for later registration.
 */
export function customToolRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.post("/custom-tools", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CustomToolCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { toolKey, ...input } = parsed.data;
    try {
      const row = await createCustomTool(db, toolKey, input);
      return c.json(row, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not create custom tool" }, 409);
    }
  });

  app.post("/custom-tools/:toolKey/versions", async (c) => {
    const toolKey = c.req.param("toolKey");
    const body = await c.req.json().catch(() => null);
    const parsed = CustomToolVersionCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      const row = await createCustomToolVersion(db, toolKey, parsed.data);
      return c.json(row, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "could not create version" }, 404);
    }
  });

  app.get("/custom-tools", async (c) => {
    return c.json(await listCustomTools(db));
  });

  app.get("/custom-tools/:toolKey/versions", async (c) => {
    const versions = await listCustomToolVersions(db, c.req.param("toolKey"));
    if (versions.length === 0) return c.json({ error: "custom tool not found" }, 404);
    return c.json(versions);
  });

  app.patch("/custom-tools/:toolKey/versions/:version", async (c) => {
    const toolKey = c.req.param("toolKey");
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1) return c.json({ error: "invalid version" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = CustomToolReviewSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const outcome = await reviewCustomToolVersion(db, toolKey, version, parsed.data);
    if (outcome.outcome === "not_found") return c.json({ error: "version not found" }, 404);
    if (outcome.outcome === "not_pending")
      return c.json({ error: "version has already been reviewed", current: outcome.row }, 409);
    return c.json(outcome.row);
  });

  return app;
}
