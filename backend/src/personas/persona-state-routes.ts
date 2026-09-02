// GET/DELETE /personas/:personaId/state. list_state only returns key names
// (the model already knows to call read_state next); this GET includes
// content so the Memory panel can render the blobs.
import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import { getPersona } from "./persona-repo.js";
import { deleteState, listState } from "./persona-state-repo.js";

export function personaStateRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.get("/personas/:personaId/state", async (c) => {
    const personaId = c.req.param("personaId");
    if (!(await getPersona(db, personaId))) return c.json({ error: "persona not found" }, 404);
    return c.json(await listState(db, personaId));
  });

  app.delete("/personas/:personaId/state/:key", async (c) => {
    const personaId = c.req.param("personaId");
    if (!(await getPersona(db, personaId))) return c.json({ error: "persona not found" }, 404);
    const key = decodeURIComponent(c.req.param("key"));
    if (!key) return c.json({ error: "key is required" }, 400);
    const deleted = await deleteState(db, personaId, key);
    if (!deleted) return c.json({ error: "state key not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
