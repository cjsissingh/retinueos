// backend/src/personas/persona-memory-routes.ts
//
// Minimal visibility/control surface for persona_memories — persona-memory-plan.md's
// Phase 5 goal ("Operator can see, correct, or prune what a persona has
// stored") without waiting on its full Memory-tab UI: a list and a delete
// are enough to make this no longer invisible-except-by-querying-Postgres.
// Same mount pattern as routine-routes.ts — mounted at "/" in app.ts,
// declares its own full `/personas/:personaId/...` paths.
import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import { getPersona } from "./persona-repo.js";
import { listMemories, forgetMemory } from "./persona-memory-repo.js";

export function personaMemoryRoutes(db: DrizzleDb): Hono {
  const app = new Hono();

  app.get("/personas/:personaId/memories", async (c) => {
    const personaId = c.req.param("personaId");
    if (!(await getPersona(db, personaId))) return c.json({ error: "persona not found" }, 404);
    return c.json(await listMemories(db, personaId));
  });

  app.delete("/personas/:personaId/memories/:memoryId", async (c) => {
    const personaId = c.req.param("personaId");
    if (!(await getPersona(db, personaId))) return c.json({ error: "persona not found" }, 404);
    const deleted = await forgetMemory(db, personaId, c.req.param("memoryId"));
    if (!deleted) return c.json({ error: "memory not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
