// backend/src/models/model-call-routes.ts
//
// Read-only visibility surface for model_calls — the cost/latency telemetry
// PR #32 started recording (persona-graph.ts's callModel → dispatcher.ts's
// OnModelCall) but never exposed. Same shape as persona-memory-routes.ts:
// mounted at "/" in app.ts, declares its own full `/personas/:personaId/...`
// path, 404s up front if the persona doesn't exist.
import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import { getPersona } from "../personas/persona-repo.js";
import { listModelCallsByPersona } from "./model-call-repo.js";

export function modelCallRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.get("/personas/:personaId/model_calls", async (c) => {
    const personaId = c.req.param("personaId");
    if (!(await getPersona(db, personaId))) return c.json({ error: "persona not found" }, 404);
    return c.json(await listModelCallsByPersona(db, personaId));
  });

  return app;
}
