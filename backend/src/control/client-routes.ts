import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import { ControlClientCreateSchema } from "./client-schemas.js";
import { createControlClient, listControlClients, revokeControlClient } from "./client-repo.js";
import { ControlError } from "./types.js";

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ControlError("invalid_input", "invalid control client limit");
  return parsed;
}

/** Owner REST adapter. Authentication is applied by createApp before this route. */
export function controlClientRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    try {
      return c.json(
        await listControlClients(db, {
          cursor: c.req.query("cursor"),
          limit: parseLimit(c.req.query("limit")),
        }),
      );
    } catch (error) {
      if (error instanceof ControlError && error.category === "invalid_input") {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.post("/", async (c) => {
    const parsed = ControlClientCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await createControlClient(db, parsed.data), 201);
  });

  app.delete("/:id", async (c) => {
    const client = await revokeControlClient(db, c.req.param("id"));
    if (!client) return c.json({ error: "control client not found" }, 404);
    return c.json(client);
  });

  return app;
}
