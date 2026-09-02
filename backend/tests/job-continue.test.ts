// backend/tests/job-continue.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { jobRoutes } from "../src/jobs/job-routes.js";
import { makeCheckpointer } from "../src/graph/checkpointer.js";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { listMemories } from "../src/personas/persona-memory-repo.js";
import { saveJobSummary } from "../src/personas/job-summary-memory.js";

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

describe("POST /jobs/:id/continue", () => {
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

  it("continues the same thread — the model actually sees the earlier turn, not just the UI", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Nice to meet you.", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "My name is Operator." }),
    });
    expect(createRes.status).toBe(202);
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    // If continuation were just a fresh isolated job (the old runJob
    // behavior), this second call would go out with no memory of "Operator" --
    // asserting on what generateText was actually CALLED WITH (not just
    // what it returns) proves the checkpointed thread carried the first
    // turn forward, which is the entire point of this endpoint existing.
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Operator, got it.", toolCalls: [] } as any);
    const continueRes = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "What's my name?" }),
    });
    expect(continueRes.status).toBe(202);
    const queued = await continueRes.json();
    expect(queued.status).toBe("queued");

    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const lastCallMessages = vi.mocked(generateText).mock.calls.at(-1)?.[0] as any;
    const serialized = JSON.stringify(lastCallMessages);
    expect(serialized).toContain("My name is Operator.");
    expect(serialized).toContain("What's my name?");

    // GET /jobs/:id/messages is what a chat view renders without replaying
    // live SSE -- both turns of both messages must be there, in order.
    const finalMessages = await (await app.request(`/jobs/${job.id}/messages`)).json();
    expect(finalMessages.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "My name is Operator."],
      ["assistant", "Nice to meet you."],
      ["user", "What's my name?"],
      ["assistant", "Operator, got it."],
    ]);
  });

  it("persists a job-scoped running summary when a continued thread crosses 8,000 estimated tokens", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Old answer.", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: `OLD_THREAD ${"x".repeat(32_000)}` }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Partial summary.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "The old thread established a private project.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "Current answer.", toolCalls: [] } as any);
    const continueRes = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Current question." }),
    });
    expect(continueRes.status).toBe(202);
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const summaries = (await listMemories(db(), persona.id)).filter((memory) =>
      memory.label.startsWith("job-summary:"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      label: `job-summary:${job.id}`,
      sourceJobId: job.id,
      content: "Summary through checkpoint message 2:\n\nThe old thread established a private project.",
    });

    // The three post-summarization turns ("Current question."/"Current
    // answer."/"Later question.") are all small and jointly fit comfortably
    // under the recent-context budget, so this continue needs no further
    // summarization pass — recentContextStart correctly extends the
    // "recent" window to cover all of them rather than collapsing every
    // turn but the newest back into the summary (see thread-hygiene.test.ts
    // for the direct regression test of that behavior). Only the response
    // call happens.
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Later answer.", toolCalls: [] } as any);
    const laterRes = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Later question." }),
    });
    expect(laterRes.status).toBe(202);
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const laterResponseCall = vi.mocked(generateText).mock.calls.at(-1)![0];
    // The summary persisted by the first continue is still the active
    // context — nothing new needed folding in.
    expect(laterResponseCall.system).toContain("The old thread established a private project.");
    expect(JSON.stringify(laterResponseCall.messages)).toContain("Current question.");
    expect(JSON.stringify(laterResponseCall.messages)).toContain("Later question.");
    expect(JSON.stringify(laterResponseCall.messages)).not.toContain("OLD_THREAD");

    const updatedSummaries = (await listMemories(db(), persona.id)).filter((memory) =>
      memory.label.startsWith("job-summary:"),
    );
    expect(updatedSummaries).toHaveLength(1);
    expect(updatedSummaries[0]?.content).toBe(
      "Summary through checkpoint message 2:\n\nThe old thread established a private project.",
    );
  });

  it("loads the persisted job summary when checkpoint summary state is absent", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Old answer.", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "OLD_RAW_CHECKPOINT_CONTEXT" }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    await saveJobSummary(db(), persona.id, job.id, {
      summary: "Persisted database summary.",
      summarizedMessageCount: 2,
    });
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Current answer.", toolCalls: [] } as any);
    const continueRes = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Current question." }),
    });
    expect(continueRes.status).toBe(202);
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const responseCall = vi.mocked(generateText).mock.calls.at(-1)![0];
    expect(responseCall.system).toContain("Persisted database summary.");
    expect(JSON.stringify(responseCall.messages)).toContain("Current question.");
    expect(JSON.stringify(responseCall.messages)).not.toContain("OLD_RAW_CHECKPOINT_CONTEXT");
  });

  it("rejects a continue while the job is still running (409), instead of racing two turns on one thread", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);

    let releaseGenerate!: (v: { text: string; toolCalls: never[] }) => void;
    const generateCalled = new Promise<void>((resolveReady) => {
      vi.mocked(generateText).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseGenerate = resolve as any;
            resolveReady();
          }),
      );
    });

    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hi" }),
    });
    const job = await createRes.json();
    expect(job.status).toBe("queued");

    const execution = runWorkerOnce();
    await generateCalled;

    const continueRes = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "again" }),
    });
    expect(continueRes.status).toBe(409);

    // The mocked generateText's promise executor runs when the graph
    // actually reaches the model call, which is somewhere inside
    // runInBackground's fire-and-forget chain -- not guaranteed to have run
    // yet just because POST /jobs already returned. Wait for it instead of
    // assuming it landed within one tick.
    releaseGenerate({ text: "done", toolCalls: [] });
    await execution;
    await pollJobStatus(app, job.id, "done");
  });

  it("rejects a continue while the job is waiting on approval (409)", async () => {
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
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "email someone" }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "waiting_approval");

    const continueRes = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "never mind" }),
    });
    expect(continueRes.status).toBe(409);
  });

  it("404s for a job that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request(`/jobs/00000000-0000-0000-0000-000000000000/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on an empty prompt", async () => {
    const app = buildApp();
    const persona = await createTestPersona(app);
    vi.mocked(generateText).mockResolvedValueOnce({ text: "hi", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hi" }),
    });
    const job = await createRes.json();
    await runWorkerOnce();
    await pollJobStatus(app, job.id, "done");

    const res = await app.request(`/jobs/${job.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(res.status).toBe(400);
  });
});
