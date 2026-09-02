// backend/tests/job-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { jobRoutes } from "../src/jobs/job-routes.js";
import { makeCheckpointer } from "../src/graph/checkpointer.js";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { enqueueRetry } from "../src/jobs/job-attempt-repo.js";
import { jobAttempts } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

async function pollJobStatus(app: Hono, jobId: string, want: string, attempts = 20): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const res = await app.request(`/jobs/${jobId}`);
    const job = await res.json();
    if (job.status === want) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const res = await app.request(`/jobs/${jobId}`);
  return res.json();
}

async function createTestPersona(app: Hono) {
  const res = await app.request("/personas", {
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
  return res.json();
}

describe("retry resumes without duplicating the human message", () => {
  let checkpointer: PostgresSaver;

  beforeEach(async () => {
    checkpointer = makeCheckpointer(process.env.DATABASE_URL!);
    await checkpointer.setup();
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await checkpointer.end?.();
  });

  function buildApp(): Hono {
    const app = new Hono();
    app.route("/personas", personaRoutes(db()));
    app.route("/jobs", jobRoutes(db(), checkpointer));
    return app;
  }

  function runWorkerOnce() {
    return new JobWorker({ db: db(), registry: defaultRegistry, checkpointer, concurrency: 1 }).runOnce();
  }

  it("retries a model failure and produces exactly one user and one assistant message", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    vi.mocked(generateText).mockRejectedValueOnce(new Error("provider exploded"));
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "Say hello." }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    const failed = await pollJobStatus(app, job.id, "failed");
    expect(failed.status).toBe("failed");

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Hello!", toolCalls: [] } as any);
    const retried = await enqueueRetry(db(), job.id);
    expect(retried?.attempt.input).toEqual({ type: "retry" });

    await runWorkerOnce();
    const done = await pollJobStatus(app, job.id, "done");
    expect(done.status).toBe("done");

    const messages = await (await app.request(`/jobs/${job.id}/messages`)).json();
    expect(messages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Say hello."],
      ["assistant", "Hello!"],
    ]);

    const lastCallMessages = vi.mocked(generateText).mock.calls.at(-1)?.[0] as any;
    const serialized = JSON.stringify(lastCallMessages);
    const occurrences = serialized.split("Say hello.").length - 1;
    expect(occurrences).toBe(1); // the retried model call sees the human message exactly once
  });

  it("retries a queued turn that was cancelled before the graph ever ran", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "Never checkpointed." }),
    });
    const job = await createRes.json();
    const cancelled = await app.request(`/jobs/${job.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(202);
    expect((await cancelled.json()).status).toBe("cancelled");

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Seen it.", toolCalls: [] } as any);
    const retryRes = await app.request(`/jobs/${job.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(202);

    await runWorkerOnce();
    const done = await pollJobStatus(app, job.id, "done");
    expect(done.status).toBe("done");

    const lastCall = vi.mocked(generateText).mock.calls.at(-1)?.[0] as { messages?: unknown };
    expect(JSON.stringify(lastCall)).toContain("Never checkpointed.");

    const messages = await (await app.request(`/jobs/${job.id}/messages`)).json();
    expect(messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "Never checkpointed."],
      ["assistant", "Seen it."],
    ]);
  });

  it("retries a cancelled continuation without dropping the new user turn", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "First reply.", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "First prompt." }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const continued = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Second prompt." }),
    });
    expect(continued.status).toBe(202);
    const cancelled = await app.request(`/jobs/${job.id}/cancel`, { method: "POST" });
    expect((await cancelled.json()).status).toBe("cancelled");

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Second reply.", toolCalls: [] } as any);
    const retryRes = await app.request(`/jobs/${job.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(202);

    await runWorkerOnce();
    const done = await pollJobStatus(app, job.id, "done");
    expect(done.status).toBe("done");

    const lastCall = vi.mocked(generateText).mock.calls.at(-1)?.[0] as { messages?: unknown };
    const serialized = JSON.stringify(lastCall);
    expect(serialized).toContain("Second prompt.");
    expect(serialized.split("Second prompt.").length - 1).toBe(1);

    const messages = await (await app.request(`/jobs/${job.id}/messages`)).json();
    expect(messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "First prompt."],
      ["assistant", "First reply."],
      ["user", "Second prompt."],
      ["assistant", "Second reply."],
    ]);
  });

  it("exposes retryEligible on GET /jobs/:id and refuses retry before that", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);
    vi.mocked(generateText).mockResolvedValueOnce({ text: "hi", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const doneJob = await (await app.request(`/jobs/${job.id}`)).json();
    expect(doneJob.retryEligible).toBe(false);
    expect(doneJob.retryBlockedReason).toMatch(/nothing to retry/);

    const retryRes = await app.request(`/jobs/${job.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(409);
  });

  it("POST /jobs/:id/retry re-queues a failed job and GET reports it eligible first", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("boom"));
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "failed");

    const failedJob = await (await app.request(`/jobs/${job.id}`)).json();
    expect(failedJob.retryEligible).toBe(true);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "hi", toolCalls: [] } as any);
    const retryRes = await app.request(`/jobs/${job.id}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(202);
    const retried = await retryRes.json();
    expect(retried.status).toBe("queued");

    await runWorkerOnce();
    const done = await pollJobStatus(app, job.id, "done");
    expect(done.status).toBe("done");
  });

  it("replays a retry on a repeated idempotency key instead of double-queuing", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("boom"));
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello" }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "failed");

    const key = "retry-key-1";
    const first = await app.request(`/jobs/${job.id}/retry`, {
      method: "POST",
      headers: { "idempotency-key": key },
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();

    const second = await app.request(`/jobs/${job.id}/retry`, {
      method: "POST",
      headers: { "idempotency-key": key },
    });
    expect(second.status).toBe(202);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);

    // The real proof that the second POST didn't double-enqueue: exactly
    // two job_attempts rows exist for this job (the original failed attempt
    // plus the one retry attempt queued by the first POST) — a buggy
    // implementation that skipped the idempotency replay and queued a
    // second retry attempt would leave 3 rows here, even though it would
    // still return the same job id (the id is fixed by the URL path
    // regardless of how many attempts got queued underneath).
    const attempts = await db().select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
    expect(attempts).toHaveLength(2);
  });
});
