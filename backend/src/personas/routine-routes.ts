import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { RoutineService } from "../control/routine-service.js";
import { ControlError } from "../control/types.js";
import type { DrizzleDb } from "../db/client.js";
import type { SchedulerHandle } from "../orchestration/scheduler.js";
import { RoutineCreateSchema, RoutineUpdateSchema } from "./routine-schemas.js";

const owner = { kind: "owner", source: "rest" } as const;

interface ServiceErrorResponse {
  status: 403 | 404 | 409 | 500 | 503;
  body: { error: string };
}

function idempotencyKey(request: Request): string {
  return request.headers.get("idempotency-key") ?? randomUUID();
}

function serviceError(error: Error): ServiceErrorResponse {
  if (!(error instanceof ControlError)) return { status: 500, body: { error: "internal server error" } };
  switch (error.category) {
    case "not_found":
      return { status: 404, body: { error: error.message } };
    case "insufficient_scope":
    case "ownership_violation":
      return { status: 403, body: { error: error.message } };
    case "idempotency_conflict":
    case "conflict":
      return { status: 409, body: { error: error.message } };
    case "scheduler_reconciliation_pending":
      return { status: 503, body: { error: error.message } };
    case "internal":
      return error.message === "no scheduler available to run this routine"
        ? { status: 503, body: { error: error.message } }
        : { status: 500, body: { error: error.message } };
    case "invalid_input":
    case "unauthenticated":
      return { status: 500, body: { error: error.message } };
  }
}

/**
 * REST supplies a trusted owner actor. Authorization, idempotency, audit
 * settlement, and scheduler reconciliation remain service responsibilities.
 */
export function routineRoutes(service: RoutineService): Hono;
export function routineRoutes(db: DrizzleDb, scheduler?: SchedulerHandle): Hono;
export function routineRoutes(serviceOrDb: RoutineService | DrizzleDb, scheduler?: SchedulerHandle): Hono {
  const service = serviceOrDb instanceof RoutineService ? serviceOrDb : new RoutineService(serviceOrDb, scheduler);
  const app = new Hono();

  app.post("/personas/:personaId/routines", async (c) => {
    const body = await c.req.json();
    const parsed = RoutineCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const routine = await service.create(owner, c.req.param("personaId"), parsed.data, idempotencyKey(c.req.raw));
      return c.json(routine, 201);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.get("/routines", async (c) => {
    try {
      return c.json(await service.listAll(owner, c.req.query("personaId")));
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.get("/routines/:id", async (c) => {
    try {
      const routine = await service.get(owner, c.req.param("id"));
      if (!routine) return c.json({ error: "routine not found" }, 404);
      return c.json(routine);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.patch("/routines/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const existing = await service.get(owner, id);
      if (!existing) return c.json({ error: "routine not found" }, 404);
      const body = await c.req.json();
      const parsed = RoutineUpdateSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
      return c.json(await service.update(owner, id, parsed.data, idempotencyKey(c.req.raw)));
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.post("/routines/:id/run-now", async (c) => {
    const id = c.req.param("id");
    try {
      const routine = await service.get(owner, id);
      if (!routine) return c.json({ error: "routine not found" }, 404);
      await service.runNow(owner, id, idempotencyKey(c.req.raw));
      return c.json({ status: "queued" }, 202);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.delete("/routines/:id", async (c) => {
    try {
      await service.delete(owner, c.req.param("id"), idempotencyKey(c.req.raw));
      return c.json({ status: "deleted" });
    } catch (error) {
      if (error instanceof ControlError && error.category === "not_found") {
        return c.json({ status: "deleted" });
      }
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  return app;
}
