import { afterEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { jobRoutes } from "../src/jobs/job-routes.js";
import { toolCallRoutes } from "../src/tool-calls/tool-call-routes.js";
import { streamRoutes } from "../src/stream/stream-routes.js";
import { defaultJobEventBus, type JobEvent } from "../src/orchestration/event-bus.js";
import { makeCheckpointer } from "../src/graph/checkpointer.js";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { defaultRegistry } from "../src/tools/registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();
const workers: JobWorker[] = [];

afterEach(async () => {
  const active = workers.splice(0);
  for (const worker of active) worker.stop();
  await Promise.all(active.map((worker) => worker.drain()));
});

async function pollJobStatus(app: Hono, jobId: string, want: string, attempts = 20): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const res = await app.request(`/jobs/${jobId}`);
    const job = await res.json();
    if (job.status === want) return job.status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const res = await app.request(`/jobs/${jobId}`);
  return (await res.json()).status;
}

async function buildApp() {
  const checkpointer = makeCheckpointer(process.env.DATABASE_URL!);
  await checkpointer.setup();
  const app = new Hono();
  app.route("/personas", personaRoutes(db()));
  app.route("/jobs", jobRoutes(db(), checkpointer));
  app.route("/tool_calls", toolCallRoutes(db(), checkpointer));
  app.route("/", streamRoutes(db(), defaultJobEventBus));
  const worker = new JobWorker({
    db: db(),
    registry: defaultRegistry,
    checkpointer,
    concurrency: 1,
    pollIntervalMs: 10,
  });
  worker.start();
  workers.push(worker);
  return app;
}

describe("tool_calls lifecycle (05-job-creation-and-audit-ui.md)", () => {
  it("writes the real result and advances status to executed once an approved destructive call actually runs", async () => {
    const app = await buildApp();
    const events: JobEvent[] = [];

    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [{ toolId: "send_email" }],
      }),
    });
    const persona = await personaRes.json();

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [
        { toolCallId: "call_1", toolName: "send_email", input: { to: "a@b.com", subject: "hi", body: "hi" } },
      ],
    } as any);
    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "email a@b.com" }),
    });
    const job = await jobRes.json();
    expect(await pollJobStatus(app, job.id, "waiting_approval")).toBe("waiting_approval");
    const unsubscribe = defaultJobEventBus.subscribe(job.id, (e) => events.push(e));

    const pendingRes = await app.request("/tool_calls?status=pending_approval");
    const [pending] = await pendingRes.json();
    expect(pending.status).toBe("pending_approval");
    expect(pending.result).toBeNull();

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Sent.", toolCalls: [] } as any);
    const approveRes = await app.request(`/tool_calls/${pending.id}/approve`, { method: "POST" });
    expect((await approveRes.json()).status).toBe("approved");

    expect(await pollJobStatus(app, job.id, "done")).toBe("done");

    const finalRes = await app.request(`/tool_calls?jobId=${job.id}`);
    const [final] = await finalRes.json();
    expect(final.id).toBe(pending.id);
    expect(final.status).toBe("executed");
    expect(final.result).toEqual({ sentTo: "a@b.com", status: "mock-sent" });

    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    unsubscribe();
  });

  it("logs a non-gated (read_only) tool call immediately as executed, not just when gated", async () => {
    const app = await buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [{ toolId: "get_weather" }],
      }),
    });
    const persona = await personaRes.json();

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "get_weather", input: { city: "Boston" } }],
      } as any)
      .mockResolvedValueOnce({ text: "It's 68 degrees.", toolCalls: [] } as any);

    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "weather?" }),
    });
    const job = await jobRes.json();
    expect(await pollJobStatus(app, job.id, "done")).toBe("done");

    const res = await app.request(`/tool_calls?jobId=${job.id}`);
    const [call] = await res.json();
    expect(call.toolId).toBe("get_weather");
    expect(call.status).toBe("executed");
    expect(call.result.temperature).toBeDefined();
  });

  it("GET /tool_calls with no filter returns every status, not just pending", async () => {
    const app = await buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [{ toolId: "get_weather" }],
      }),
    });
    const persona = await personaRes.json();
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "call_1", toolName: "get_weather", input: { city: "Boston" } }],
      } as any)
      .mockResolvedValueOnce({ text: "done", toolCalls: [] } as any);
    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "weather?" }),
    });
    const job = await jobRes.json();
    await pollJobStatus(app, job.id, "done");

    const res = await app.request("/tool_calls");
    const all = await res.json();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.every((tc: { status: string }) => tc.status === "executed")).toBe(true);
  });
});
