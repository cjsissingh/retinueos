import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetSettingsCache } from "../src/config.js";
import { createControlClient } from "../src/control/client-repo.js";
import { createControlAuditEvent, listControlAuditEvents } from "../src/control/control-repo.js";
import { createControlPlane } from "../src/control/control-plane.js";
import { createJob, getJob, listJobs, transitionJobStatus } from "../src/jobs/job-repo.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createRoutine, getRoutine, listRoutines } from "../src/personas/routine-repo.js";
import { createToolCall, getToolCall } from "../src/tool-calls/tool-call-repo.js";
import type { SchedulerHandle } from "../src/orchestration/scheduler.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function legacyRequest(id: number | string | null, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function modernRequest(id: number | string | null, method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: MODERN_META } };
}

async function mcpRequest(
  app: ReturnType<typeof createApp>,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const method = typeof body.method === "string" ? body.method : "";
  const params =
    body.params !== null && typeof body.params === "object" ? Object.fromEntries(Object.entries(body.params)) : {};
  const meta =
    params._meta !== null && typeof params._meta === "object"
      ? Object.fromEntries(Object.entries(params._meta))
      : undefined;
  const requestHeaders = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Mcp-Method": method,
    "content-type": "application/json",
  });
  if (typeof meta?.["io.modelcontextprotocol/protocolVersion"] === "string") {
    requestHeaders.set("Mcp-Protocol-Version", meta["io.modelcontextprotocol/protocolVersion"]);
  }
  if (typeof params.name === "string") requestHeaders.set("Mcp-Name", params.name);
  return app.request("/mcp/control", {
    method: "POST",
    headers: new Headers([...requestHeaders, ...Object.entries(headers)]),
    body: JSON.stringify(body),
  });
}

async function mcpJson(response: Response) {
  const body = await response.text();
  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) return JSON.parse(body);
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data!);
}

function mcpJsonText(body: string) {
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? body);
}

async function callTool(
  app: ReturnType<typeof createApp>,
  token: string,
  requestId: number | string,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const response = await mcpRequest(
    app,
    token,
    modernRequest(requestId, "tools/call", { name, arguments: arguments_ }),
  );
  const body = await mcpJson(response);
  return { response, body, result: body.result as Record<string, unknown> };
}

function schedulerFake(overrides: Partial<SchedulerHandle> = {}): SchedulerHandle {
  return {
    registerAll: vi.fn(),
    start: vi.fn(),
    unschedule: vi.fn(),
    reschedule: vi.fn(),
    runNow: vi.fn(),
    replaceAll: vi.fn(),
    ...overrides,
  };
}

async function pendingApproval() {
  const persona = await createPersona(db(), {
    name: "Approver",
    role: "Reviewer",
    systemPrompt: "Review carefully.",
    modelProvider: "anthropic",
    modelName: "test",
    assignedToolIds: [],
  });
  const job = await createJob(db(), {
    personaId: persona.id,
    depth: 0,
    origin: "user",
    prompt: "Approve this",
  });
  await transitionJobStatus(db(), job.id, "queued", "waiting_approval");
  return createToolCall(db(), {
    jobId: job.id,
    toolId: "send_email",
    riskClass: "destructive",
    arguments: {},
  });
}

describe("control-plane MCP", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.FRONTEND_ORIGIN = "http://localhost:3000";
    process.env.BACKEND_URL = "http://localhost:8080";
    resetSettingsCache();
  });

  it("rejects unauthenticated control MCP requests", async () => {
    const response = await createApp(undefined, db()).request("/mcp/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        legacyRequest(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        }),
      ),
    });

    expect(response.status).toBe(401);
  });

  it("serves the current discovery handshake and stateless legacy initialization", async () => {
    const client = await createControlClient(db(), { name: "Reader", scopes: ["personas:read"] });
    const app = createApp(undefined, db());

    const discovery = await mcpRequest(app, client.token, modernRequest(1, "server/discover"));
    const initialized = await mcpRequest(
      app,
      client.token,
      legacyRequest(2, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1" },
      }),
    );

    expect(discovery.status).toBe(200);
    expect(await mcpJson(discovery)).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    expect(initialized.status).toBe(200);
    expect(await mcpJson(initialized)).toMatchObject({ id: 2, result: { serverInfo: { name: "retinueos" } } });
  });

  it("filters discovery by scope and refuses direct calls to learned out-of-scope tools", async () => {
    const client = await createControlClient(db(), { name: "Persona reader", scopes: ["personas:read"] });
    const app = createApp(undefined, db());

    const listed = await mcpRequest(app, client.token, legacyRequest(1, "tools/list"));
    const forbidden = await mcpRequest(
      app,
      client.token,
      legacyRequest(2, "tools/call", {
        name: "retinueos_routines_list",
        arguments: {},
      }),
    );

    expect(listed.status).toBe(200);
    const tools = (await mcpJson(listed)).result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(["retinueos_personas_list", "retinueos_personas_get"]);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "missing required scope: routines:read" });
  });

  it("returns bounded paginated persona results through a scope-bound read tool", async () => {
    const persona = await createPersona(db(), {
      name: "Ada",
      role: "Researcher",
      systemPrompt: "Be precise.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const client = await createControlClient(db(), { name: "Persona reader", scopes: ["personas:read"] });
    const response = await mcpRequest(
      createApp(undefined, db()),
      client.token,
      legacyRequest(1, "tools/call", {
        name: "retinueos_personas_list",
        arguments: { limit: 500 },
      }),
    );

    expect(response.status).toBe(200);
    expect(await mcpJson(response)).toMatchObject({
      id: 1,
      result: {
        structuredContent: { items: [expect.objectContaining({ id: persona.id, name: "Ada" })], nextCursor: null },
        content: [{ type: "text" }],
      },
    });
  });

  it("exposes every read-only control tool to a fully scoped client", async () => {
    const client = await createControlClient(db(), {
      name: "All readers",
      scopes: ["personas:read", "jobs:read", "routines:read", "approvals:read", "audit:read"],
    });
    const response = await mcpRequest(createApp(undefined, db()), client.token, legacyRequest(1, "tools/list"));

    expect(response.status).toBe(200);
    expect((await mcpJson(response)).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "retinueos_personas_list",
      "retinueos_personas_get",
      "retinueos_jobs_list",
      "retinueos_jobs_get",
      "retinueos_routines_list",
      "retinueos_approvals_list",
      "retinueos_audit_list",
    ]);
  });

  it("rejects untrusted browser origins and insecure non-local backend URLs", async () => {
    const client = await createControlClient(db(), { name: "Reader", scopes: ["personas:read"] });
    const app = createApp(undefined, db());
    const invalidOrigin = await mcpRequest(app, client.token, legacyRequest(1, "tools/list"), {
      Origin: "https://evil.example",
    });

    process.env.BACKEND_URL = "http://api.example.test";
    resetSettingsCache();
    const insecureApp = createApp(undefined, db());
    const insecureBackend = await mcpRequest(insecureApp, client.token, legacyRequest(2, "tools/list"));

    expect(invalidOrigin.status).toBe(403);
    expect(insecureBackend.status).toBe(403);
  });

  it("allows an SDK browser preflight only from the configured frontend origin", async () => {
    const app = createApp(undefined, db());
    const allowed = await app.request("/mcp/control", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, content-type, mcp-method, mcp-name, mcp-protocol-version, mcp-session-id, last-event-id",
      },
    });
    const denied = await app.request("/mcp/control", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type, mcp-method, mcp-protocol-version",
      },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(allowed.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(allowed.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("mcp-name");
    expect(allowed.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("mcp-protocol-version");
    expect(denied.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("dispatches all read tools under the current protocol with paginated result shapes", async () => {
    const persona = await createPersona(db(), {
      name: "Ada",
      role: "Researcher",
      systemPrompt: "Be precise.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user", prompt: "Investigate" });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Daily",
      cronSchedule: "0 9 * * *",
      promptTemplate: "Check in",
    });
    const approval = await createToolCall(db(), {
      jobId: job.id,
      toolId: "safe",
      riskClass: "safe",
      arguments: {},
      status: "pending_approval",
    });
    await createControlAuditEvent(db(), {
      actor: { kind: "owner", source: "rest" },
      action: "job.create",
      targetType: "job",
      targetId: job.id,
      outcome: "succeeded",
    });
    const client = await createControlClient(db(), {
      name: "All readers",
      scopes: ["personas:read", "jobs:read", "routines:read", "approvals:read", "audit:read"],
    });
    const app = createApp(undefined, db());
    const calls = [
      [
        "retinueos_personas_list",
        {},
        (content: Record<string, unknown>) =>
          expect(content.items).toEqual([expect.objectContaining({ id: persona.id })]),
      ],
      [
        "retinueos_personas_get",
        { id: persona.id },
        (content: Record<string, unknown>) => expect(content.item).toEqual(expect.objectContaining({ id: persona.id })),
      ],
      [
        "retinueos_jobs_list",
        {},
        (content: Record<string, unknown>) => expect(content.items).toEqual([expect.objectContaining({ id: job.id })]),
      ],
      [
        "retinueos_jobs_get",
        { id: job.id },
        (content: Record<string, unknown>) =>
          expect(content).toMatchObject({ job: { id: job.id }, messages: { items: expect.any(Array) } }),
      ],
      [
        "retinueos_routines_list",
        {},
        (content: Record<string, unknown>) =>
          expect(content.items).toEqual([expect.objectContaining({ id: routine.id })]),
      ],
      [
        "retinueos_approvals_list",
        {},
        (content: Record<string, unknown>) =>
          expect(content.items).toEqual([expect.objectContaining({ id: approval.id })]),
      ],
      [
        "retinueos_audit_list",
        {},
        (content: Record<string, unknown>) =>
          expect(content.items).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: job.id })])),
      ],
    ] as const;

    for (const [name, arguments_, assertContent] of calls) {
      const response = await mcpRequest(
        app,
        client.token,
        modernRequest(1, "tools/call", { name, arguments: arguments_ }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const result = (await mcpJson(response)).result;
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
      assertContent(result.structuredContent);
    }
  });

  it("keeps successful tool text content even when the payload exceeds the 4 KiB error cap", async () => {
    // boundJson at MAX_MCP_ERROR_BYTES replaces oversize JSON with a sha256
    // stub. MCP clients read content[0].text, so a charter (or a short list
    // of jobs) larger than 4 KiB used to hide every id behind that digest.
    const charter = `You are a researcher.\n${"Be precise. ".repeat(400)}`;
    expect(Buffer.byteLength(JSON.stringify({ item: { systemPrompt: charter } }))).toBeGreaterThan(4096);
    const persona = await createPersona(db(), {
      name: "Ada",
      role: "Researcher",
      systemPrompt: charter,
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const client = await createControlClient(db(), { name: "Persona reader", scopes: ["personas:read"] });
    const { result } = await callTool(createApp(undefined, db()), client.token, 1, "retinueos_personas_get", {
      id: persona.id,
    });

    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as { truncated?: boolean; item?: { id: string; systemPrompt: string } };
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.item).toMatchObject({ id: persona.id, systemPrompt: charter });
    expect(result.structuredContent).toMatchObject({ item: { id: persona.id, systemPrompt: charter } });
  });

  it("dispatches a representative read tool through the legacy stateless transport", async () => {
    const persona = await createPersona(db(), {
      name: "Legacy Ada",
      role: "Researcher",
      systemPrompt: "Be precise.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const client = await createControlClient(db(), { name: "Legacy reader", scopes: ["personas:read"] });
    const response = await mcpRequest(
      createApp(undefined, db()),
      client.token,
      legacyRequest(1, "tools/call", {
        name: "retinueos_personas_get",
        arguments: { id: persona.id },
      }),
    );

    expect(response.status).toBe(200);
    expect((await mcpJson(response)).result.structuredContent.item).toMatchObject({ id: persona.id });
  });

  it.each([
    ["personas:read", "retinueos_personas_list", "retinueos_jobs_list", "jobs:read"],
    ["jobs:read", "retinueos_jobs_list", "retinueos_routines_list", "routines:read"],
    ["routines:read", "retinueos_routines_list", "retinueos_approvals_list", "approvals:read"],
    ["approvals:read", "retinueos_approvals_list", "retinueos_audit_list", "audit:read"],
    ["audit:read", "retinueos_audit_list", "retinueos_personas_list", "personas:read"],
  ] as const)(
    "enforces %s discovery and direct-call scope boundaries",
    async (scope, visible, forbidden, missingScope) => {
      const client = await createControlClient(db(), { name: `${scope} reader`, scopes: [scope] });
      const app = createApp(undefined, db());
      const listed = await mcpRequest(app, client.token, modernRequest(1, "tools/list"));
      const direct = await mcpRequest(
        app,
        client.token,
        modernRequest(2, "tools/call", { name: forbidden, arguments: {} }),
      );

      expect((await mcpJson(listed)).result.tools.map((tool: { name: string }) => tool.name)).toContain(visible);
      expect(direct.status).toBe(403);
      expect(await direct.json()).toEqual({ error: `missing required scope: ${missingScope}` });
    },
  );

  it.each([
    ["jobs:write", "retinueos_jobs_create", "retinueos_routines_create", "routines:write"],
    ["routines:write", "retinueos_routines_create", "retinueos_approvals_resolve", "approvals:write"],
    ["approvals:write", "retinueos_approvals_resolve", "retinueos_jobs_create", "jobs:write"],
  ] as const)(
    "filters %s mutation discovery and rejects direct hidden-tool calls",
    async (scope, visible, forbidden, missingScope) => {
      const client = await createControlClient(db(), { name: `${scope} writer`, scopes: [scope] });
      const app = createApp(undefined, db());
      const listed = await mcpRequest(app, client.token, modernRequest(1, "tools/list"));
      const direct = await callTool(app, client.token, 2, forbidden, {});

      const tools = (await mcpJson(listed)).result.tools.map((tool: { name: string }) => tool.name);
      expect(tools).toContain(visible);
      expect(tools).not.toContain(forbidden);
      expect(direct.response.status).toBe(403);
      expect(direct.body).toEqual({ error: `missing required scope: ${missingScope}` });
    },
  );

  it("creates, continues, and cancels jobs without treating JSON-RPC ids as idempotency keys", async () => {
    const persona = await createPersona(db(), {
      name: "Operator",
      role: "Researcher",
      systemPrompt: "Be precise.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const client = await createControlClient(db(), { name: "Job writer", scopes: ["jobs:write"] });
    const app = createApp(undefined, db());
    const createArguments = { personaId: persona.id, prompt: "Investigate" };

    const first = await callTool(app, client.token, "transport-create", "retinueos_jobs_create", createArguments);
    // JSON-RPC ids are reused across MCP sessions. A later create with the
    // same id must enqueue a new job — both when arguments match (would have
    // silently replayed) and when they differ (would have 409'd).
    const reusedSameArguments = await callTool(
      app,
      client.token,
      "transport-create",
      "retinueos_jobs_create",
      createArguments,
    );
    const reusedDifferentArguments = await callTool(app, client.token, "transport-create", "retinueos_jobs_create", {
      personaId: persona.id,
      prompt: "A different investigation",
    });
    const explicitFirst = await callTool(app, client.token, 2, "retinueos_jobs_create", {
      personaId: persona.id,
      prompt: "Stable retry",
      idempotencyKey: "stable-job-create",
    });
    const explicitReplay = await callTool(app, client.token, 3, "retinueos_jobs_create", {
      personaId: persona.id,
      prompt: "Stable retry",
      idempotencyKey: "stable-job-create",
    });
    const mismatch = await callTool(app, client.token, 4, "retinueos_jobs_create", {
      personaId: persona.id,
      prompt: "Different arguments",
      idempotencyKey: "stable-job-create",
    });

    expect(first.response.status).toBe(200);
    expect(reusedSameArguments.response.status).toBe(200);
    expect(reusedDifferentArguments.response.status).toBe(200);
    expect(reusedDifferentArguments.result.isError).not.toBe(true);
    expect((reusedSameArguments.result.structuredContent as { id: string }).id).not.toBe(
      (first.result.structuredContent as { id: string }).id,
    );
    expect((reusedDifferentArguments.result.structuredContent as { id: string }).id).not.toBe(
      (first.result.structuredContent as { id: string }).id,
    );
    expect(
      (
        await listControlAuditEvents(db(), {
          targetId: (first.result.structuredContent as { id: string }).id,
          limit: 50,
        })
      ).items[0],
    ).toMatchObject({ actorKind: "mcp_client", actorId: client.client.id, action: "job.create" });
    expect(explicitReplay.result.structuredContent).toMatchObject({
      id: (explicitFirst.result.structuredContent as { id: string }).id,
    });
    expect(await listJobs(db())).toHaveLength(4);
    expect(mismatch.result).toMatchObject({
      isError: true,
      structuredContent: { category: "idempotency_conflict", retryable: false },
    });

    const terminalJob = await createJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "user",
      prompt: "Finished opening turn",
    });
    const continuedJobId = terminalJob.id;
    await transitionJobStatus(db(), terminalJob.id, "queued", "done");
    const continued = await callTool(app, client.token, 5, "retinueos_jobs_continue", {
      jobId: continuedJobId,
      prompt: "Go deeper",
    });
    const cancellable = await callTool(app, client.token, 6, "retinueos_jobs_create", {
      personaId: persona.id,
      prompt: "Cancel me",
    });
    const cancelled = await callTool(app, client.token, 7, "retinueos_jobs_cancel", {
      jobId: (cancellable.result.structuredContent as { id: string }).id,
    });

    expect(continued.result.structuredContent).toMatchObject({ id: continuedJobId, status: "queued" });
    expect(cancelled.result.structuredContent).toMatchObject({ status: "cancelled" });
  });

  it("dispatches a representative mutation through the legacy stateless transport", async () => {
    const persona = await createPersona(db(), {
      name: "Legacy operator",
      role: "Researcher",
      systemPrompt: "Be precise.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const client = await createControlClient(db(), { name: "Legacy job writer", scopes: ["jobs:write"] });
    const response = await mcpRequest(
      createApp(undefined, db()),
      client.token,
      legacyRequest("legacy-create", "tools/call", {
        name: "retinueos_jobs_create",
        arguments: { personaId: persona.id, prompt: "Legacy dispatch" },
      }),
    );

    expect(response.status).toBe(200);
    expect((await mcpJson(response)).result.structuredContent).toMatchObject({ status: "queued" });
  });

  it("executes the full routine lifecycle with strict cron and enabled-create semantics", async () => {
    const persona = await createPersona(db(), {
      name: "Scheduler",
      role: "Planner",
      systemPrompt: "Plan carefully.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const scheduler = schedulerFake();
    const plane = createControlPlane({ db: db(), settings: { availableProviders: ["anthropic"] }, scheduler });
    const app = createApp(undefined, db(), undefined, plane);
    const client = await createControlClient(db(), { name: "Routine writer", scopes: ["routines:write"] });

    const invalid = await callTool(app, client.token, 1, "retinueos_routines_create", {
      personaId: persona.id,
      name: "Invalid",
      cronSchedule: "not a cron",
      promptTemplate: "Never",
    });
    expect(invalid.result).toMatchObject({
      isError: true,
      structuredContent: { category: "invalid_input" },
    });
    expect(await listRoutines(db())).toEqual([]);

    const disabled = await callTool(app, client.token, 2, "retinueos_routines_create", {
      personaId: persona.id,
      name: "Initially paused",
      cronSchedule: "0 7 * * *",
      promptTemplate: "Wait",
      enabled: false,
    });
    expect(disabled.result.structuredContent).toMatchObject({ enabled: false });

    const created = await callTool(app, client.token, 3, "retinueos_routines_create", {
      personaId: persona.id,
      name: "Daily",
      cronSchedule: "0 8 * * *",
      promptTemplate: "Check in",
      enabled: true,
    });
    const routineId = (created.result.structuredContent as { id: string }).id;
    const updated = await callTool(app, client.token, 4, "retinueos_routines_update", {
      routineId,
      name: "Daily review",
      notifyRoutineRan: true,
    });
    const paused = await callTool(app, client.token, 5, "retinueos_routines_pause", { routineId });
    const resumed = await callTool(app, client.token, 6, "retinueos_routines_resume", { routineId });
    const ran = await callTool(app, client.token, 7, "retinueos_routines_run", { routineId });
    const deleted = await callTool(app, client.token, 8, "retinueos_routines_delete", { routineId });

    expect(created.result.structuredContent).toMatchObject({ id: routineId, enabled: true });
    expect(updated.result.structuredContent).toMatchObject({
      id: routineId,
      name: "Daily review",
      notifyRoutineRan: true,
    });
    expect(paused.result.structuredContent).toMatchObject({ id: routineId, enabled: false });
    expect(resumed.result.structuredContent).toMatchObject({ id: routineId, enabled: true });
    expect(ran.result.structuredContent).toEqual({ status: "queued" });
    expect(deleted.result.structuredContent).toEqual({ status: "deleted" });
    expect(await getRoutine(db(), routineId)).toBeUndefined();
    expect(scheduler.runNow).toHaveBeenCalledWith(routineId);
  });

  it("creates a disabled MCP routine in one unscheduled create operation and replays it", async () => {
    const persona = await createPersona(db(), {
      name: "Paused scheduler",
      role: "Planner",
      systemPrompt: "Wait.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const scheduler = schedulerFake();
    const plane = createControlPlane({ db: db(), settings: { availableProviders: ["anthropic"] }, scheduler });
    const app = createApp(undefined, db(), undefined, plane);
    const client = await createControlClient(db(), { name: "Paused routine writer", scopes: ["routines:write"] });
    const arguments_ = {
      personaId: persona.id,
      name: "Initially paused",
      cronSchedule: "0 7 * * *",
      promptTemplate: "Wait",
      enabled: false,
      idempotencyKey: "mcp-disabled-create-1",
    };

    const first = await callTool(app, client.token, 1, "retinueos_routines_create", arguments_);
    const replay = await callTool(app, client.token, 2, "retinueos_routines_create", arguments_);
    const routineId = (first.result.structuredContent as { id: string }).id;

    expect(first.result.structuredContent).toMatchObject({ id: routineId, enabled: false });
    expect(replay.result.structuredContent).toEqual(first.result.structuredContent);
    expect(scheduler.registerAll).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(await listControlAuditEvents(db(), { targetId: routineId, limit: 100 })).toMatchObject({
      items: [expect.objectContaining({ action: "routine.create", outcome: "succeeded" })],
    });
    expect(
      (await db().query.controlOperations.findMany()).filter((operation) => operation.targetId === routineId),
    ).toHaveLength(1);
  });

  it("returns structured scheduler-pending errors and recovers the committed routine on retry", async () => {
    const persona = await createPersona(db(), {
      name: "Reconciler",
      role: "Planner",
      systemPrompt: "Recover.",
      modelProvider: "anthropic",
      modelName: "test",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Before",
      cronSchedule: "0 9 * * *",
      promptTemplate: "Check",
    });
    const scheduler = schedulerFake({
      reschedule: vi.fn(() => {
        throw new Error("scheduler unavailable");
      }),
    });
    const plane = createControlPlane({ db: db(), settings: { availableProviders: ["anthropic"] }, scheduler });
    const app = createApp(undefined, db(), undefined, plane);
    const client = await createControlClient(db(), { name: "Routine writer", scopes: ["routines:write"] });
    const arguments_ = { routineId: routine.id, name: "Committed", idempotencyKey: "reconcile-update" };

    const pending = await callTool(app, client.token, 1, "retinueos_routines_update", arguments_);
    expect(pending.result).toMatchObject({
      isError: true,
      structuredContent: { category: "scheduler_reconciliation_pending", retryable: true },
    });
    expect(await getRoutine(db(), routine.id)).toMatchObject({ name: "Committed" });

    const recovered = await callTool(app, client.token, 2, "retinueos_routines_update", arguments_);
    expect(recovered.result.structuredContent).toMatchObject({ id: routine.id, name: "Committed" });
    expect(scheduler.reschedule).toHaveBeenCalledTimes(1);
    expect(scheduler.replaceAll).toHaveBeenCalledTimes(2);
  });

  it("approves, rejects, replays, and reports stale approval conflicts through the shared lifecycle", async () => {
    const approvedCall = await pendingApproval();
    const rejectedCall = await pendingApproval();
    const staleCall = await pendingApproval();
    await transitionJobStatus(db(), staleCall.jobId, "waiting_approval", "failed", "lost resume ownership");
    const client = await createControlClient(db(), { name: "Approval writer", scopes: ["approvals:write"] });
    const app = createApp(undefined, db());

    const approved = await callTool(app, client.token, 1, "retinueos_approvals_resolve", {
      toolCallId: approvedCall.id,
      decision: "approve",
      idempotencyKey: "approve-call",
    });
    const replayed = await callTool(app, client.token, 2, "retinueos_approvals_resolve", {
      toolCallId: approvedCall.id,
      decision: "approve",
      idempotencyKey: "approve-call",
    });
    const rejected = await callTool(app, client.token, 3, "retinueos_approvals_resolve", {
      toolCallId: rejectedCall.id,
      decision: "reject",
    });
    const stale = await callTool(app, client.token, 4, "retinueos_approvals_resolve", {
      toolCallId: staleCall.id,
      decision: "approve",
    });

    expect(approved.result.structuredContent).toMatchObject({ id: approvedCall.id, status: "approved" });
    expect(replayed.result.structuredContent).toMatchObject({ id: approvedCall.id, status: "approved" });
    expect(rejected.result.structuredContent).toMatchObject({ id: rejectedCall.id, status: "rejected" });
    expect(await getToolCall(db(), approvedCall.id)).toMatchObject({ status: "approved" });
    expect(await getToolCall(db(), rejectedCall.id)).toMatchObject({ status: "rejected" });
    expect(await getJob(db(), approvedCall.jobId)).toMatchObject({ status: "queued" });
    expect(await getJob(db(), rejectedCall.jobId)).toMatchObject({ status: "queued" });
    expect(stale.result).toMatchObject({
      isError: true,
      structuredContent: { category: "conflict", retryable: false },
    });
    expect(await getToolCall(db(), staleCall.id)).toMatchObject({ status: "pending_approval" });
  });

  it("bounds domain and SDK validation tool errors to 4 KiB", async () => {
    const client = await createControlClient(db(), { name: "Job reader", scopes: ["jobs:read", "personas:read"] });
    const app = createApp(undefined, db());
    const domain = await mcpRequest(
      app,
      client.token,
      modernRequest(1, "tools/call", {
        name: "retinueos_jobs_get",
        arguments: { id: "00000000-0000-0000-0000-000000000000" },
      }),
    );
    const oversizedName = `retinueos_${"x".repeat(6000)}`;
    const validation = await mcpRequest(
      app,
      client.token,
      modernRequest(2, "tools/call", {
        name: oversizedName,
        arguments: {},
      }),
    );
    const domainBody = await domain.text();
    const validationBody = await validation.text();

    expect(domain.status, domainBody).toBe(200);
    expect(mcpJsonText(domainBody).result).toMatchObject({ isError: true });
    expect(Buffer.byteLength(domainBody)).toBeLessThanOrEqual(4096);
    expect(validation.status).toBe(200);
    expect(mcpJsonText(validationBody)).toEqual(
      expect.objectContaining({
        jsonrpc: "2.0",
        error: expect.objectContaining({ code: expect.any(Number), data: { truncated: true } }),
      }),
    );
    expect(Buffer.byteLength(validationBody)).toBeLessThanOrEqual(4096);
  });

  it("caps every malformed tools/call error without echoing oversized client fields", async () => {
    const client = await createControlClient(db(), { name: "Persona reader", scopes: ["personas:read"] });
    const app = createApp(undefined, db());
    const oversizedKey = "k".repeat(6000);
    const oversizedValue = "v".repeat(6000);
    const oversizedId = "i".repeat(6000);
    const oversizedMeta = { ...MODERN_META, "example.invalid/attacker": oversizedValue };
    const cases = [
      {
        label: "missing name",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { _meta: MODERN_META, arguments: { [oversizedKey]: oversizedValue } },
        },
        id: 1,
      },
      {
        label: "non-string name",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { _meta: MODERN_META, name: 42, arguments: { [oversizedKey]: oversizedValue } },
        },
        id: 2,
      },
      {
        label: "oversized unknown argument",
        body: modernRequest(3, "tools/call", {
          name: "retinueos_personas_list",
          arguments: { [oversizedKey]: oversizedValue },
        }),
        id: 3,
      },
      {
        label: "oversized id",
        body: modernRequest(oversizedId, "tools/call", {
          name: "retinueos_personas_list",
          arguments: { [oversizedKey]: oversizedValue },
        }),
        id: null,
      },
      {
        label: "oversized metadata",
        body: {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            _meta: oversizedMeta,
            name: "retinueos_personas_list",
            arguments: { [oversizedKey]: oversizedValue },
          },
        },
        id: 5,
      },
    ];

    for (const { label, body, id } of cases) {
      const response = await mcpRequest(app, client.token, body);
      const raw = await response.text();
      const parsed = mcpJsonText(raw);

      expect(Buffer.byteLength(raw), label).toBeLessThanOrEqual(4096);
      expect(parsed).toMatchObject({ jsonrpc: "2.0", id });
      expect(parsed.error?.code ?? parsed.result?.isError, label).toBeTruthy();
    }
  });
});
