import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { jobRoutes, type JobRouteControls } from "../src/jobs/job-routes.js";
import { claimAttemptById, getQueuedAttemptForJob } from "../src/jobs/job-attempt-repo.js";
import { resetSettingsCache } from "../src/config.js";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { defaultRegistry } from "../src/tools/registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

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

function buildApp(controls?: JobRouteControls): Hono {
  const app = new Hono();
  app.route("/personas", personaRoutes(db()));
  app.route("/jobs", jobRoutes(db(), undefined, controls));
  return app;
}

async function createJobForCancellation(app: Hono) {
  const personaRes = await app.request("/personas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Cancel tester",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    }),
  });
  const persona = await personaRes.json();
  const response = await app.request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId: persona.id, prompt: "stop me" }),
  });
  return response.json();
}

describe("POST /jobs error handling", () => {
  it("replays an idempotent REST create without changing its successful response shape", async () => {
    const app = buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [],
      }),
    });
    const persona = await personaRes.json();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "same-job" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
    } as const;

    const first = await app.request("/jobs", request);
    const second = await app.request("/jobs", request);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
  });

  it("marks the job failed instead of crashing the process when runJob rejects", async () => {
    const unhandled: unknown[] = [];
    // `reason`'s type is Node's own `unhandledRejection` listener signature
    // (process.on("unhandledRejection", (reason: unknown, promise) => ...))
    // -- not ours to narrow.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const app = buildApp();
      const personaRes = await app.request("/personas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "A",
          role: "R",
          systemPrompt: "S",
          modelProvider: "anthropic",
          modelName: "m",
          assignedToolIds: [],
        }),
      });
      const persona = await personaRes.json();

      vi.mocked(generateText).mockRejectedValueOnce(new Error("provider exploded"));

      const jobRes = await app.request("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
      });
      expect(jobRes.status).toBe(202);
      const job = await jobRes.json();

      const worker = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 });
      await worker.runOnce();

      expect(await pollJobStatus(app, job.id, "failed")).toBe("failed");

      // The whole point of persisting `error` — see job-repo.ts and
      // job-routes.ts's catch — is that this message ends up somewhere the
      // UI can show it instead of only ever reaching console.error.
      const finalRes = await app.request(`/jobs/${job.id}`);
      const finalJob = await finalRes.json();
      expect(finalJob.error).toContain("provider exploded");
      expect(finalJob.prompt).toBe("hello");

      // Give the process a tick to surface any unhandled rejection before asserting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects with 409 instead of enqueuing when the persona's provider has no API key configured", async () => {
    const app = buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "openai",
        modelName: "m",
        assignedToolIds: [],
      }),
    });
    const persona = await personaRes.json();
    const callsBefore = vi.mocked(generateText).mock.calls.length;

    // Global setup only exports ANTHROPIC_API_KEY, so "openai" is unconfigured.
    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
    });
    expect(jobRes.status).toBe(409);
    const body = await jobRes.json();
    expect(body.error).toMatch(/openai/);
    expect(body.error).toMatch(/OPENAI_API_KEY/);
    // The reject happens before a job row (and thus a model call) is ever
    // created — no new generateText call should show up from this request.
    expect(vi.mocked(generateText).mock.calls.length).toBe(callsBefore);
  });

  it("rejects with 409 when no provider at all is configured", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    resetSettingsCache();
    try {
      const app = buildApp();
      const personaRes = await app.request("/personas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "A",
          role: "R",
          systemPrompt: "S",
          modelProvider: "anthropic",
          modelName: "m",
          assignedToolIds: [],
        }),
      });
      const persona = await personaRes.json();

      const jobRes = await app.request("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
      });
      expect(jobRes.status).toBe(409);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      resetSettingsCache();
    }
  });
});

describe("POST /jobs/:id/cancel", () => {
  it("terminalizes queued work and blocks continuation", async () => {
    const app = buildApp();
    const job = await createJobForCancellation(app);
    const cancelled = await app.request(`/jobs/${job.id}/cancel`, { method: "POST" });

    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    const continued = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "try anyway" }),
    });
    expect(continued.status).toBe(409);
    expect((await continued.json()).error).toContain("cannot be continued");
  });

  it("persists running cancellation before waking the local worker", async () => {
    const abortAttempt = vi.fn();
    const app = buildApp({ abortAttempt });
    const job = await createJobForCancellation(app);
    const attempt = await getQueuedAttemptForJob(db(), job.id);
    expect(attempt).toBeDefined();
    await claimAttemptById(db(), attempt!.id, "worker-a");

    const response = await app.request(`/jobs/${job.id}/cancel`, { method: "POST" });

    expect(await response.json()).toMatchObject({ status: "cancelling" });
    expect(abortAttempt).toHaveBeenCalledWith(attempt!.id);
  });
});

describe("GET /jobs/:id/model_calls", () => {
  it("404s for a job that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request("/jobs/00000000-0000-0000-0000-000000000000/model_calls");
    expect(res.status).toBe(404);
  });

  it("returns the model calls a completed job actually made", async () => {
    const app = buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        assignedToolIds: [],
      }),
    });
    const persona = await personaRes.json();

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "hi there",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    } as any);

    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
    });
    const job = await jobRes.json();

    const worker = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 });
    await worker.runOnce();
    await pollJobStatus(app, job.id, "done");

    const res = await app.request(`/jobs/${job.id}/model_calls`);
    expect(res.status).toBe(200);
    const calls = await res.json();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      jobId: job.id,
      provider: "anthropic",
      model: "claude-sonnet-5",
      finishReason: "stop",
      totalTokens: 5,
    });
  });
});
