import { randomUUID } from "node:crypto";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { z } from "zod";
import { requireControlClient, type ControlClientEnv } from "../auth/middleware.js";
import { getSettings } from "../config.js";
import type { DrizzleDb } from "../db/client.js";
import { JobContinueSchema, JobCreateSchema } from "../jobs/job-schemas.js";
import { RoutineCreateSchema, RoutineUpdateSchema } from "../personas/routine-schemas.js";
import { boundJson } from "./bounded-json.js";
import type { ControlPlane } from "./control-plane.js";
import { ControlError, type ControlActor, type ControlScope, type PageRequest } from "./types.js";
import type { ListControlAuditEventsInput } from "./control-repo.js";

// MCP tool payloads deliberately carry the paginated JSON records owned by the control services.
/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters */

const MAX_MCP_ERROR_BYTES = 4 * 1024;
const MAX_SAFE_JSON_RPC_ID_BYTES = 256;

const pageSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    cursor: { type: "string" },
    limit: { type: "number" },
  },
  additionalProperties: false,
});

const idSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    id: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "number" },
  },
  required: ["id"],
  additionalProperties: false,
});

const auditSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    cursor: { type: "string" },
    limit: { type: "number" },
    action: { type: "string" },
    targetType: { type: "string" },
    targetId: { type: "string" },
    outcome: { type: "string" },
  },
  additionalProperties: false,
});

const idempotencyKeyProperty = { type: "string", minLength: 1 } as const;
const uuidProperty = { type: "string", format: "uuid" } as const;

const jobCreateSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    personaId: uuidProperty,
    prompt: { type: "string", minLength: 1 },
    idempotencyKey: idempotencyKeyProperty,
  },
  required: ["personaId", "prompt"],
  additionalProperties: false,
});

const jobContinueSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    jobId: uuidProperty,
    prompt: { type: "string", minLength: 1 },
    idempotencyKey: idempotencyKeyProperty,
  },
  required: ["jobId", "prompt"],
  additionalProperties: false,
});

const jobIdSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: { jobId: uuidProperty, idempotencyKey: idempotencyKeyProperty },
  required: ["jobId"],
  additionalProperties: false,
});

const routineCreateSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    personaId: uuidProperty,
    name: { type: "string", minLength: 1 },
    cronSchedule: { type: "string", minLength: 1 },
    promptTemplate: { type: "string", minLength: 1 },
    notifyRoutineRan: { type: "boolean" },
    kind: { type: "string", enum: ["job", "digest"] },
    enabled: { type: "boolean" },
    idempotencyKey: idempotencyKeyProperty,
  },
  required: ["personaId", "name", "cronSchedule", "promptTemplate"],
  additionalProperties: false,
});

const routineUpdateSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    routineId: uuidProperty,
    name: { type: "string", minLength: 1 },
    cronSchedule: { type: "string", minLength: 1 },
    promptTemplate: { type: "string", minLength: 1 },
    notifyRoutineRan: { type: "boolean" },
    enabled: { type: "boolean" },
    kind: { type: "string", enum: ["job", "digest"] },
    idempotencyKey: idempotencyKeyProperty,
  },
  required: ["routineId"],
  additionalProperties: false,
});

const routineIdSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: { routineId: uuidProperty, idempotencyKey: idempotencyKeyProperty },
  required: ["routineId"],
  additionalProperties: false,
});

const approvalResolveSchema = fromJsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    toolCallId: uuidProperty,
    decision: { type: "string", enum: ["approve", "reject"] },
    idempotencyKey: idempotencyKeyProperty,
  },
  required: ["toolCallId", "decision"],
  additionalProperties: false,
});

const toolScopes = {
  retinueos_personas_list: "personas:read",
  retinueos_personas_get: "personas:read",
  retinueos_jobs_list: "jobs:read",
  retinueos_jobs_get: "jobs:read",
  retinueos_jobs_create: "jobs:write",
  retinueos_jobs_continue: "jobs:write",
  retinueos_jobs_cancel: "jobs:write",
  retinueos_routines_list: "routines:read",
  retinueos_routines_create: "routines:write",
  retinueos_routines_update: "routines:write",
  retinueos_routines_pause: "routines:write",
  retinueos_routines_resume: "routines:write",
  retinueos_routines_run: "routines:write",
  retinueos_routines_delete: "routines:write",
  retinueos_approvals_list: "approvals:read",
  retinueos_approvals_resolve: "approvals:write",
  retinueos_audit_list: "audit:read",
} as const satisfies Record<string, ControlScope>;

type McpActor = Extract<ControlActor, { kind: "mcp_client" }>;

function actorFor(client: ControlClientEnv["Variables"]["controlClient"]): McpActor {
  return { kind: "mcp_client", clientId: client.id, scopes: client.scopes };
}

function page(input: Record<string, unknown>): PageRequest {
  const rawLimit = input.limit;
  const limit = typeof rawLimit === "number" ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50;
  return { cursor: typeof input.cursor === "string" ? input.cursor : undefined, limit };
}

function requiredScope(toolName: string): ControlScope | undefined {
  return isToolName(toolName) ? toolScopes[toolName] : undefined;
}

function isToolName(value: string): value is keyof typeof toolScopes {
  return Object.hasOwn(toolScopes, value);
}

function requireScope(actor: McpActor, scope: ControlScope): void {
  if (!actor.scopes.includes(scope)) {
    throw new ControlError("insufficient_scope", `missing required scope: ${scope}`);
  }
}

function structuredContent(value: object): Record<string, unknown> {
  return Array.isArray(value) ? { items: value } : Object.fromEntries(Object.entries(value));
}

function toolResult(value: object) {
  // Successful payloads are the actual page/record the model needs to act
  // on. boundJson's 4 KiB hash-stub is for error envelopes (and audit
  // storage); applying it here replaced retinueos_jobs_list / personas_get
  // text content with `{ truncated: true, digest }` as soon as a charter
  // or a handful of job prompts crossed 4 KiB. MCP clients feed
  // content[0].text to the model, so the agent would see a hash instead of
  // the ids it needs. structuredContent was already unbounded — keep the
  // two views in lockstep. Error paths still use MAX_MCP_ERROR_BYTES.
  const payload = structuredContent(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function withControlError<T extends object>(run: () => Promise<T>) {
  try {
    return toolResult(await run());
  } catch (error) {
    const detail =
      error instanceof ControlError
        ? { category: error.category, message: error.message, retryable: error.retryable }
        : { category: "internal", message: "control-plane read failed", retryable: true };
    const bounded = boundJson(detail, MAX_MCP_ERROR_BYTES);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(bounded) }],
      structuredContent:
        bounded !== null && typeof bounded === "object" ? structuredContent(bounded) : { detail: bounded },
    };
  }
}

function parseDomainInput<Schema extends z.ZodTypeAny>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ControlError("invalid_input", parsed.error.message);
  return parsed.data;
}

function uuid(input: Record<string, unknown>, field: string): string {
  return parseDomainInput(z.string().uuid(), input[field]);
}

function mutationIdempotencyKey(input: Record<string, unknown>, requestId: unknown): string {
  if (input.idempotencyKey !== undefined) {
    return parseDomainInput(z.string().min(1), input.idempotencyKey);
  }
  // JSON-RPC request ids are unique only inside one client session, and every
  // session that shares this control-client token lives in the same
  // (actor, action, idempotency_key) namespace. Using the raw id as the
  // durable key made a later `retinueos_jobs_create` with id 1 either replay
  // an unrelated earlier job or fail with idempotency_conflict. REST already
  // defaults to a unique key when Idempotency-Key is absent; MCP does too.
  // Clients that want retry-safe replay must pass idempotencyKey.
  if (typeof requestId !== "string" && typeof requestId !== "number") {
    throw new ControlError("invalid_input", "MCP mutation requires a JSON-RPC request id");
  }
  return randomUUID();
}

function routineCreateInput(input: Record<string, unknown>) {
  const routine = parseDomainInput(RoutineCreateSchema, {
    name: input.name,
    cronSchedule: input.cronSchedule,
    promptTemplate: input.promptTemplate,
    notifyRoutineRan: input.notifyRoutineRan,
    kind: input.kind,
  });
  return {
    ...routine,
    enabled: input.enabled === undefined ? true : parseDomainInput(z.boolean(), input.enabled),
  };
}

function routinePatch(input: Record<string, unknown>) {
  const entries = Object.entries(input).filter(
    ([key, value]) => key !== "routineId" && key !== "idempotencyKey" && value !== undefined,
  );
  return parseDomainInput(RoutineUpdateSchema, Object.fromEntries(entries));
}

function id(input: Record<string, unknown>): string {
  if (typeof input.id !== "string") throw new ControlError("invalid_input", "id is required");
  return input.id;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  // SAFETY: `typeof value === "string"` makes this a membership test against the string union in `values`.
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ControlError("invalid_input", "invalid audit filter");
  }
  // SAFETY: membership in `values` was confirmed directly above.
  return value as T;
}

function auditInput(input: Record<string, unknown>): ListControlAuditEventsInput {
  return {
    ...page(input),
    action: enumValue(input.action, [
      "routine.create",
      "routine.update",
      "routine.pause",
      "routine.resume",
      "routine.run",
      "routine.delete",
      "job.create",
      "job.continue",
      "job.retry",
      "job.cancel",
      "approval.approve",
      "approval.reject",
      "client.create",
      "client.revoke",
    ] as const),
    targetType: enumValue(input.targetType, ["routine", "job", "tool_call", "control_client"] as const),
    targetId: typeof input.targetId === "string" ? input.targetId : undefined,
    outcome: enumValue(input.outcome, ["pending", "succeeded", "failed"] as const),
  };
}

function registerAllowedTools(server: McpServer, controlPlane: ControlPlane, actor: McpActor): void {
  if (actor.scopes.includes("personas:read")) {
    server.registerTool(
      "retinueos_personas_list",
      {
        description: "List RetinueOS personas in a cursor page.",
        inputSchema: pageSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "personas:read");
          return controlPlane.personas.listPage(actor, page(input));
        }),
    );
    server.registerTool(
      "retinueos_personas_get",
      {
        description: "Get one RetinueOS persona by id.",
        inputSchema: idSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "personas:read");
          return { item: await controlPlane.personas.get(actor, id(input)) };
        }),
    );
  }

  if (actor.scopes.includes("jobs:read")) {
    server.registerTool(
      "retinueos_jobs_list",
      {
        description: "List RetinueOS jobs in a cursor page.",
        inputSchema: pageSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "jobs:read");
          return controlPlane.jobs.listPage(actor, page(input));
        }),
    );
    server.registerTool(
      "retinueos_jobs_get",
      {
        description: "Get a RetinueOS job and one cursor page of its messages.",
        inputSchema: idSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "jobs:read");
          return controlPlane.jobs.getDetails(actor, id(input), page(input));
        }),
    );
  }

  if (actor.scopes.includes("jobs:write")) {
    server.registerTool(
      "retinueos_jobs_create",
      {
        description:
          "Create and durably queue a RetinueOS job. Pass idempotencyKey to retry the same create safely; JSON-RPC request ids are not idempotency keys.",
        inputSchema: jobCreateSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "jobs:write");
          const jobInput = parseDomainInput(JobCreateSchema, {
            personaId: input.personaId,
            prompt: input.prompt,
          });
          return controlPlane.jobs.create(actor, jobInput, mutationIdempotencyKey(input, ctx.mcpReq.id));
        }),
    );
    server.registerTool(
      "retinueos_jobs_continue",
      {
        description: "Queue another user turn on a terminal RetinueOS job.",
        inputSchema: jobContinueSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "jobs:write");
          const continueInput = parseDomainInput(JobContinueSchema, { prompt: input.prompt });
          return controlPlane.jobs.continue(
            actor,
            uuid(input, "jobId"),
            continueInput,
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
        }),
    );
    server.registerTool(
      "retinueos_jobs_cancel",
      {
        description: "Request durable cancellation of a RetinueOS job.",
        inputSchema: jobIdSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "jobs:write");
          return controlPlane.jobs.cancel(actor, uuid(input, "jobId"), mutationIdempotencyKey(input, ctx.mcpReq.id));
        }),
    );
  }

  if (actor.scopes.includes("routines:read")) {
    server.registerTool(
      "retinueos_routines_list",
      {
        description: "List RetinueOS routines in a cursor page.",
        inputSchema: pageSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "routines:read");
          return controlPlane.routines.listPage(actor, page(input));
        }),
    );
  }

  if (actor.scopes.includes("routines:write")) {
    server.registerTool(
      "retinueos_routines_create",
      {
        description:
          "Create a scheduled RetinueOS routine. It starts enabled unless enabled is false. Pass idempotencyKey to retry the same create safely; JSON-RPC request ids are not idempotency keys.",
        inputSchema: routineCreateSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "routines:write");
          const key = mutationIdempotencyKey(input, ctx.mcpReq.id);
          const createInput = routineCreateInput(input);
          return controlPlane.routines.create(actor, uuid(input, "personaId"), createInput, key);
        }),
    );
    server.registerTool(
      "retinueos_routines_update",
      {
        description: "Update fields on a RetinueOS routine.",
        inputSchema: routineUpdateSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "routines:write");
          return controlPlane.routines.update(
            actor,
            uuid(input, "routineId"),
            routinePatch(input),
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
        }),
    );
    server.registerTool(
      "retinueos_routines_pause",
      {
        description: "Pause a RetinueOS routine.",
        inputSchema: routineIdSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "routines:write");
          return controlPlane.routines.pause(
            actor,
            uuid(input, "routineId"),
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
        }),
    );
    server.registerTool(
      "retinueos_routines_resume",
      {
        description: "Resume a RetinueOS routine.",
        inputSchema: routineIdSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "routines:write");
          return controlPlane.routines.resume(
            actor,
            uuid(input, "routineId"),
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
        }),
    );
    server.registerTool(
      "retinueos_routines_run",
      {
        description: "Queue an immediate run of a RetinueOS routine.",
        inputSchema: routineIdSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "routines:write");
          await controlPlane.routines.runNow(
            actor,
            uuid(input, "routineId"),
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
          return { status: "queued" };
        }),
    );
    server.registerTool(
      "retinueos_routines_delete",
      {
        description: "Permanently delete a RetinueOS routine.",
        inputSchema: routineIdSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "routines:write");
          await controlPlane.routines.delete(
            actor,
            uuid(input, "routineId"),
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
          return { status: "deleted" };
        }),
    );
  }

  if (actor.scopes.includes("approvals:read")) {
    server.registerTool(
      "retinueos_approvals_list",
      {
        description: "List pending RetinueOS approvals in a cursor page.",
        inputSchema: pageSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "approvals:read");
          return controlPlane.approvals.listPending(actor, page(input));
        }),
    );
  }

  if (actor.scopes.includes("approvals:write")) {
    server.registerTool(
      "retinueos_approvals_resolve",
      {
        description: "Approve or reject a pending RetinueOS tool call and resume its job.",
        inputSchema: approvalResolveSchema,
      },
      (input, ctx) =>
        withControlError(async () => {
          requireScope(actor, "approvals:write");
          const decision = parseDomainInput(z.enum(["approve", "reject"]), input.decision);
          return controlPlane.approvals.resolve(
            actor,
            uuid(input, "toolCallId"),
            decision,
            mutationIdempotencyKey(input, ctx.mcpReq.id),
          );
        }),
    );
  }

  if (actor.scopes.includes("audit:read")) {
    server.registerTool(
      "retinueos_audit_list",
      {
        description: "List RetinueOS control audit events in a cursor page.",
        inputSchema: auditSchema,
      },
      (input) =>
        withControlError(async () => {
          requireScope(actor, "audit:read");
          return controlPlane.audit.list(actor, auditInput(input));
        }),
    );
  }
}

function allowedOrigins(): Set<string> {
  const settings = getSettings();
  const backend = new URL(settings.backendUrl);
  const isLocal = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(backend.hostname);
  if (backend.protocol !== "https:" && !isLocal) {
    throw new ControlError("insufficient_scope", "BACKEND_URL must use HTTPS outside localhost");
  }
  return new Set([new URL(settings.frontendOrigin).origin, backend.origin]);
}

interface McpRequestInspection {
  isToolsCall: boolean;
  toolName?: string;
}

async function inspectMcpRequest(request: Request): Promise<McpRequestInspection> {
  if (request.method !== "POST") return { isToolsCall: false };
  const headerIndicatesToolCall = request.headers.get("mcp-method") === "tools/call";
  try {
    const body = await request.clone().json();
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return { isToolsCall: headerIndicatesToolCall };
    const record = Object.fromEntries(Object.entries(body));
    const isToolsCall = headerIndicatesToolCall || record.method === "tools/call";
    if (!isToolsCall || record.params === null || typeof record.params !== "object") return { isToolsCall };
    const params = Object.fromEntries(Object.entries(record.params));
    return { isToolsCall, toolName: typeof params.name === "string" ? params.name : undefined };
  } catch {
    return { isToolsCall: headerIndicatesToolCall };
  }
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return headers;
}

interface McpErrorResult {
  content: { type: "text"; text: string }[];
  structuredContent: { category: string; message: string; truncated: true };
  isError: true;
  resultType?: string;
}

interface McpJsonRpcError {
  code: number;
  message: string;
  data: { truncated: true };
}

function cappedToolError(result: Record<string, unknown>): McpErrorResult {
  const summary = {
    category: "invalid_input",
    message: "MCP tool input validation failed",
    truncated: true as const,
  };
  const capped: McpErrorResult = {
    content: [{ type: "text", text: JSON.stringify(summary) }],
    structuredContent: summary,
    isError: true,
  };
  if (typeof result.resultType === "string") capped.resultType = result.resultType;
  return capped;
}

function cappedJsonRpcError(error: Record<string, unknown>): McpJsonRpcError {
  return {
    code: typeof error.code === "number" ? error.code : -32600,
    message: "MCP request validation failed",
    data: { truncated: true },
  };
}

function safeJsonRpcId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Buffer.byteLength(value) <= MAX_SAFE_JSON_RPC_ID_BYTES) return value;
  return null;
}

function cappedBody(sse: boolean, response: Record<string, unknown>): string {
  const encoded = JSON.stringify(response);
  const body = sse ? `event: message\ndata: ${encoded}\n\n` : encoded;
  if (Buffer.byteLength(body) <= MAX_MCP_ERROR_BYTES) return body;
  const fallback = JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "MCP request validation failed", data: { truncated: true } },
  });
  return sse ? `event: message\ndata: ${fallback}\n\n` : fallback;
}

/**
 * The SDK validates a tool input before its callback runs. Limit an oversized
 * SDK-generated tool error after dispatch while retaining its JSON-RPC id
 * when it is safe to echo and its MCP error shape.
 */
async function boundToolErrorResponse(response: Response): Promise<Response> {
  const body = await response.text();
  if (Buffer.byteLength(body) <= MAX_MCP_ERROR_BYTES) {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
    });
  }

  const sse = response.headers.get("content-type")?.startsWith("text/event-stream") ?? false;
  const data = sse
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : body;
  try {
    // SAFETY: this response is parsed only for an oversized tool-call response; every accessed member is narrowed below.
    const parsed = JSON.parse(data ?? "") as Record<string, unknown>;
    if (parsed.error !== null && typeof parsed.error === "object" && !Array.isArray(parsed.error)) {
      const error = Object.fromEntries(Object.entries(parsed.error));
      return new Response(
        cappedBody(sse, { jsonrpc: "2.0", id: safeJsonRpcId(parsed.id), error: cappedJsonRpcError(error) }),
        {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders(response),
        },
      );
    }
    if (parsed.result === null || typeof parsed.result !== "object" || Array.isArray(parsed.result)) {
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response),
      });
    }
    const result = Object.fromEntries(Object.entries(parsed.result));
    if (result.isError !== true) {
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response),
      });
    }
    return new Response(
      cappedBody(sse, { jsonrpc: "2.0", id: safeJsonRpcId(parsed.id), result: cappedToolError(result) }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response),
      },
    );
  } catch {
    return new Response(
      cappedBody(sse, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "MCP request validation failed", data: { truncated: true } },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response),
      },
    );
  }
}

/** Authenticated Streamable HTTP adapter for the single /mcp/control endpoint. */
export function controlMcpRoutes(controlPlane: ControlPlane, db: DrizzleDb): Hono<ControlClientEnv> {
  const app = new Hono<ControlClientEnv>();
  app.use("*", requireControlClient(db));
  app.all("/", async (c) => {
    let origins: Set<string>;
    try {
      origins = allowedOrigins();
    } catch (error) {
      const message = error instanceof ControlError ? error.message : "invalid BACKEND_URL";
      return c.json({ error: message }, 403);
    }

    const origin = c.req.header("Origin");
    if (origin !== undefined && !origins.has(origin)) return c.json({ error: "untrusted Origin" }, 403);

    const actor = actorFor(c.get("controlClient"));
    const request = await inspectMcpRequest(c.req.raw);
    const scope = request.toolName ? requiredScope(request.toolName) : undefined;
    if (scope && !actor.scopes.includes(scope)) return c.json({ error: `missing required scope: ${scope}` }, 403);

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "retinueos", version: "1.0.0" }, { capabilities: { tools: {} } });
      registerAllowedTools(server, controlPlane, actor);
      return server;
    });
    const response = await handler.fetch(c.req.raw);
    return request.isToolsCall ? boundToolErrorResponse(response) : response;
  });
  return app;
}
