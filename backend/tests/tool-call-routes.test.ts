import { afterEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { jobRoutes } from "../src/jobs/job-routes.js";
import { toolCallRoutes } from "../src/tool-calls/tool-call-routes.js";
import { makeCheckpointer } from "../src/graph/checkpointer.js";
import { jobs } from "../src/db/schema.js";
import { getJob, transitionJobStatus } from "../src/jobs/job-repo.js";
import { getToolCall } from "../src/tool-calls/tool-call-repo.js";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { ApprovalService } from "../src/control/approval-service.js";

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
  app.route("/tool_calls", toolCallRoutes(db(), checkpointer, new ApprovalService(db())));
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

describe("tool call approval flow", () => {
  it("approving a pending destructive call resumes the job to done", async () => {
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

    const pendingRes = await app.request("/tool_calls?status=pending_approval");
    const pending = await pendingRes.json();
    expect(pending).toHaveLength(1);

    let releaseResume!: (value: { text: string; toolCalls: never[] }) => void;
    const resumeModelCalled = new Promise<void>((resolveCalled) => {
      vi.mocked(generateText).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseResume = resolve as typeof releaseResume;
            resolveCalled();
          }),
      );
    });
    const approveRes = await app.request(`/tool_calls/${pending[0].id}/approve`, { method: "POST" });
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe("approved");

    // A successful response means the approval decision and resume ownership
    // committed together, even while model execution is still blocked.
    expect(["queued", "running"]).toContain((await getJob(db(), job.id))?.status);
    await resumeModelCalled;
    releaseResume({ text: "Sent.", toolCalls: [] });

    expect(await pollJobStatus(app, job.id, "done")).toBe("done");
  });

  it("leaves the approval pending when its job can no longer be claimed for resume", async () => {
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
    const job = await (
      await app.request("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, prompt: "email a@b.com" }),
      })
    ).json();
    expect(await pollJobStatus(app, job.id, "waiting_approval")).toBe("waiting_approval");
    const [pending] = await (await app.request("/tool_calls?status=pending_approval")).json();

    await transitionJobStatus(db(), job.id, "waiting_approval", "failed", "simulated ownership loss");
    const callsBefore = vi.mocked(generateText).mock.calls.length;
    const approveRes = await app.request(`/tool_calls/${pending.id}/approve`, { method: "POST" });

    expect(approveRes.status).toBe(409);
    expect((await getToolCall(db(), pending.id))?.status).toBe("pending_approval");
    expect((await getJob(db(), job.id))?.status).toBe("failed");
    expect(vi.mocked(generateText).mock.calls.length).toBe(callsBefore);
  });

  it("rejects approving an already-resolved tool call with 409", async () => {
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

    const pendingRes = await app.request("/tool_calls?status=pending_approval");
    const [pending] = await pendingRes.json();

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Sent.", toolCalls: [] } as any);
    await app.request(`/tool_calls/${pending.id}/approve`, { method: "POST" });

    const secondRes = await app.request(`/tool_calls/${pending.id}/approve`, { method: "POST" });
    expect(secondRes.status).toBe(409);

    // Drain the first approve's fire-and-forget resume before the test
    // ends and useTestDb's afterEach closes the connection pool out from
    // under it.
    expect(await pollJobStatus(app, job.id, "done")).toBe("done");
  });

  it("lets only one concurrent approve/reject decision claim the resume (TOCTOU regression)", async () => {
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

    const pendingRes = await app.request("/tool_calls?status=pending_approval");
    const [pending] = await pendingRes.json();

    // Only one resumed model turn should ever actually run.
    vi.mocked(generateText).mockResolvedValueOnce({ text: "Sent.", toolCalls: [] } as any);
    const callsBefore = vi.mocked(generateText).mock.calls.length;

    const [firstRes, secondRes] = await Promise.all([
      app.request(`/tool_calls/${pending.id}/approve`, { method: "POST" }),
      app.request(`/tool_calls/${pending.id}/reject`, { method: "POST" }),
    ]);

    const statuses = [firstRes.status, secondRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    expect(await pollJobStatus(app, job.id, "done")).toBe("done");
    // Exactly one additional generateText call happened (the single resumed turn).
    expect(vi.mocked(generateText).mock.calls.length).toBe(callsBefore + 1);
  });

  it("creates exactly one child job when a turn combines delegate_to with an approved destructive call", async () => {
    // Regression test for the interrupt-replay bug (see task-9-report.md):
    // before the two-phase callTools restructuring, resuming this turn would
    // re-run the delegate_to side effect and create a duplicate child job.
    const app = await buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Principal",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [{ toolId: "delegate_to" }, { toolId: "send_email" }],
      }),
    });
    const persona = await personaRes.json();

    const financeRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Finance",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [],
      }),
    });
    const finance = await financeRes.json();

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          toolCallId: "call_1",
          toolName: "delegate_to",
          input: { personaId: finance.id, task: "check finances" },
        },
        { toolCallId: "call_2", toolName: "send_email", input: { to: "a@b.com", subject: "hi", body: "hi" } },
      ],
    } as any);
    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "delegate and email" }),
    });
    const job = await jobRes.json();
    expect(await pollJobStatus(app, job.id, "waiting_approval")).toBe("waiting_approval");

    const pendingRes = await app.request("/tool_calls?status=pending_approval");
    const pending = await pendingRes.json();
    expect(pending).toHaveLength(1);
    expect(pending[0].toolId).toBe("send_email");

    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Delegated and sent.", toolCalls: [] } as any)
      .mockResolvedValueOnce({ text: "Finances look fine.", toolCalls: [] } as any);
    const approveRes = await app.request(`/tool_calls/${pending[0].id}/approve`, { method: "POST" });
    expect(approveRes.status).toBe(200);

    expect(await pollJobStatus(app, job.id, "done")).toBe("done");

    const children = await db().select().from(jobs).where(eq(jobs.parentJobId, job.id));
    expect(children).toHaveLength(1);
    expect(children[0].personaId).toBe(finance.id);
    expect(children[0].status).toBe("done");
  });

  it("always-allow persists Allow on the persona and refuses destructive tools", async () => {
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
        assignedToolIds: [{ toolId: "write_state", permission: "ask" }, { toolId: "send_email" }],
      }),
    });
    const persona = await personaRes.json();

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolCallId: "call_1", toolName: "write_state", input: { key: "notes", content: "hi" } }],
    } as any);
    const job = await (
      await app.request("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, prompt: "note this down" }),
      })
    ).json();
    expect(await pollJobStatus(app, job.id, "waiting_approval")).toBe("waiting_approval");
    const [pending] = await (await app.request("/tool_calls?status=pending_approval")).json();

    vi.mocked(generateText).mockResolvedValueOnce({ text: "Saved.", toolCalls: [] } as any);
    const alwaysRes = await app.request(`/tool_calls/${pending.id}/always-allow`, { method: "POST" });
    expect(alwaysRes.status).toBe(200);
    expect(await pollJobStatus(app, job.id, "done")).toBe("done");

    const refreshed = await (await app.request(`/personas/${persona.id}`)).json();
    expect(refreshed.assignedToolIds).toEqual(expect.arrayContaining([{ toolId: "write_state", permission: "allow" }]));

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [{ toolCallId: "call_2", toolName: "send_email", input: { to: "a@b.com", subject: "s", body: "b" } }],
    } as any);
    const destructiveJob = await (
      await app.request("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, prompt: "email a@b.com" }),
      })
    ).json();
    expect(await pollJobStatus(app, destructiveJob.id, "waiting_approval")).toBe("waiting_approval");
    const [destructivePending] = await (await app.request("/tool_calls?status=pending_approval")).json();
    const destructiveAlways = await app.request(`/tool_calls/${destructivePending.id}/always-allow`, {
      method: "POST",
    });
    expect(destructiveAlways.status).toBe(400);
    expect(await destructiveAlways.json()).toEqual({ error: "destructive tools cannot be always allowed" });
    expect((await getToolCall(db(), destructivePending.id))?.status).toBe("pending_approval");
  });
});
