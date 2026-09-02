import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { DrizzleDb } from "../db/client.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { JobRow } from "../db/schema.js";
import { JobCreateSchema, JobContinueSchema } from "./job-schemas.js";
import { getSettings } from "../config.js";
import { JobService } from "../control/job-service.js";
import { ControlError } from "../control/types.js";
import type { ControlActor } from "../control/types.js";

export interface JobRouteControls {
  abortAttempt?(attemptId: string): void;
  publishStatus?(jobId: string, status: string): void;
}

const owner = { kind: "owner", source: "rest" } as const;

function idempotencyKey(request: Request): string {
  return request.headers.get("idempotency-key") ?? randomUUID();
}

interface ServiceErrorResponse {
  status: 403 | 404 | 409 | 500;
  body: { error: string };
}

function serviceError(error: Error): ServiceErrorResponse {
  if (!(error instanceof ControlError)) return { status: 500, body: { error: "internal server error" } };
  switch (error.category) {
    case "not_found":
      return { status: 404, body: { error: error.message } };
    case "conflict":
    case "idempotency_conflict":
      return { status: 409, body: { error: error.message } };
    case "insufficient_scope":
    case "ownership_violation":
      return { status: 403, body: { error: error.message } };
    default:
      return { status: 500, body: { error: error.message } };
  }
}

/**
 * Decorates a single JobRow with the same retryEligible/retryBlockedReason
 * fields GET /:id already computes, so frontend/lib/api-client.ts's Job
 * type can keep retryEligible required. Deliberately not applied to any
 * list-returning route (GET /) -- that would multiply this extra query by
 * every job in the list.
 */
async function withRetryEligibility(service: JobService, actor: ControlActor, job: JobRow) {
  const retry = await service.retryEligibility(actor, job.id);
  return { ...job, retryEligible: retry.eligible, retryBlockedReason: retry.reason };
}

export function jobRoutes(
  db: DrizzleDb,
  _checkpointer?: BaseCheckpointSaver,
  controls: JobRouteControls = {},
  jobService?: JobService,
): Hono {
  const app = new Hono();
  const service = jobService ?? new JobService(db, getSettings(), controls);

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = JobCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    try {
      const job = await service.create(owner, parsed.data, idempotencyKey(c.req.raw));
      return c.json(await withRetryEligibility(service, owner, job), 202);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  // Continues an existing chat (job) with a new user message on the SAME
  // langgraphThreadId, instead of spawning a new isolated job — this is
  // what makes the persona page's "Chats" a real multi-turn conversation
  // rather than a list of one-shot dispatches that merely look grouped. One
  // job row is one whole chat: `prompt` stays the opening message, new
  // turns land in the messages table (see jobs/message-repo.ts's
  // createMessage and dispatcher.ts's driveTurn, which appends the
  // assistant's reply the same way regardless of whether this is turn 1 or
  // turn 12).
  //
  // Continuation only actually gives the model memory of earlier turns when
  // a checkpointer is configured (app.ts/server.ts always wire one up via
  // graph/checkpointer.ts's makeCheckpointer -- only test harnesses pass
  // `undefined`) -- LangGraph's own saved state is what carries context
  // forward across two separate driveTurn calls sharing one thread_id, not
  // anything this route does itself. Without one, this still "works" in the
  // sense that the model answers, but has no memory of the earlier turns;
  // there's no way to detect that case from here (the checkpointer is an
  // implementation detail of the graph the route never sees), so this is a
  // documented limitation, not a guarded one.
  app.post("/:id/continue", async (c) => {
    const job = await service.get(owner, c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);

    const body = await c.req.json();
    const parsed = JobContinueSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    try {
      const continued = await service.continue(owner, job.id, parsed.data, idempotencyKey(c.req.raw));
      return c.json(await withRetryEligibility(service, owner, continued), 202);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/retry", async (c) => {
    try {
      const retried = await service.retry(owner, c.req.param("id"), idempotencyKey(c.req.raw));
      return c.json(await withRetryEligibility(service, owner, retried), 202);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.post("/:id/cancel", async (c) => {
    try {
      const cancelled = await service.cancel(owner, c.req.param("id"), idempotencyKey(c.req.raw));
      return c.json(await withRetryEligibility(service, owner, cancelled), 202);
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  app.get("/", async (c) => {
    const personaId = c.req.query("personaId");
    const parentJobId = c.req.query("parentJobId");
    if (parentJobId) return c.json(await service.listAll(owner, { parentJobId }));
    if (personaId) return c.json(await service.listAll(owner, { personaId }));
    return c.json(await service.listAll(owner));
  });

  app.get("/:id", async (c) => {
    const job = await service.get(owner, c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json(await withRetryEligibility(service, owner, job));
  });

  // The chat's message history (schema.ts's messages doc comment) --
  // oldest first. A historical/reloaded chat renders this merged with
  // GET /tool_calls?jobId= by createdAt, since tool activity isn't message
  // content here (see the frontend's persona chat page).
  app.get("/:id/messages", async (c) => {
    try {
      return c.json(await service.listMessagesAll(owner, c.req.param("id")));
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  // Model-call telemetry (schema.ts's modelCalls doc comment): every real
  // generateText() call this job made, oldest first as returned -- token
  // usage, finish reason, latency, and provider errors, for a chat's own
  // "what did this actually cost" view.
  app.get("/:id/model_calls", async (c) => {
    try {
      return c.json(await service.listModelCalls(owner, c.req.param("id")));
    } catch (error) {
      const response = serviceError(error instanceof Error ? error : new Error("internal server error"));
      return c.json(response.body, response.status);
    }
  });

  return app;
}
