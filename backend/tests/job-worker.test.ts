import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobAttempts, jobs, notifications, personaState, toolCalls } from "../src/db/schema.js";
import {
  claimAttemptById,
  createQueuedJob,
  getJobAttempt,
  listJobAttempts,
  requestJobCancellation,
} from "../src/jobs/job-attempt-repo.js";
import { getJob } from "../src/jobs/job-repo.js";
import { getLastAssistantMessage } from "../src/jobs/message-repo.js";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { JobEventBus, type JobEvent } from "../src/orchestration/event-bus.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createToolCall } from "../src/tool-calls/tool-call-repo.js";
import { writeState, readState } from "../src/personas/persona-state-repo.js";
import { listMemories } from "../src/personas/persona-memory-repo.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { useTestDb } from "./setup/db.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();
const originalWebhook = process.env.NOTIFY_WEBHOOK_URL;

afterEach(() => {
  if (originalWebhook === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
  else process.env.NOTIFY_WEBHOOK_URL = originalWebhook;
  vi.unstubAllGlobals();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createExecution(prompt: string) {
  const persona = await createPersona(db(), {
    name: `Worker ${prompt}`,
    role: "R",
    systemPrompt: "S",
    voiceNotes: "",
    boundaries: "",
    scopeDescription: "",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  return createQueuedJob(db(), {
    personaId: persona.id,
    depth: 0,
    origin: "user",
    prompt,
    langgraphThreadId: randomUUID(),
  });
}

describe("JobWorker", () => {
  it("aborts active execution after observing a cross-process cancellation", async () => {
    const execution = await createExecution("cancel me");
    const started = deferred();
    const sawAbort = deferred();
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 1_000,
      abortGraceMs: 100,
      execute: async (_claimed, context) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              sawAbort.resolve();
              resolve();
            },
            { once: true },
          );
        });
        throw new Error("aborted by signal");
      },
    });

    const run = worker.runOnce();
    await started.promise;
    await requestJobCancellation(db(), execution.job.id, 100);
    await sawAbort.promise;
    await run;

    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "cancelled" });
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "cancelled" });
  });

  it("durably cascades parent cancellation into an active delegated child", async () => {
    const parent = await createExecution("cancel delegated work");
    const childStarted = deferred();
    const childAborted = deferred();
    let childJobId: string | undefined;
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 1_000,
      abortGraceMs: 100,
      execute: async (execution, context) => {
        if (execution.job.parentJobId) {
          childJobId = execution.job.id;
          childStarted.resolve();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                // Nested cancel must still settle after abort grace: parent
                // leaseExpiresAt is cut to abortAfter, and this delay exceeds it.
                setTimeout(() => {
                  childAborted.resolve();
                  resolve();
                }, 150);
              },
              { once: true },
            );
          });
          throw new Error("child aborted");
        }
        await context.executeDelegatedChild({
          personaId: execution.job.personaId,
          prompt: "child",
          langgraphThreadId: randomUUID(),
        });
        return { status: "done" };
      },
    });

    const run = worker.runOnce();
    await childStarted.promise;
    await requestJobCancellation(db(), parent.job.id, 100);
    await childAborted.promise;
    await run;

    expect(childJobId).toBeDefined();
    if (!childJobId) throw new Error("child job was not created");
    expect(await getJob(db(), parent.job.id)).toMatchObject({ status: "cancelled" });
    expect(await getJob(db(), childJobId)).toMatchObject({ status: "cancelled" });
  });

  it("does not publish locally produced events discarded by cancellation settlement", async () => {
    const execution = await createExecution("cancel raced completion");
    const started = deferred();
    const release = deferred();
    const bus = new JobEventBus();
    const events: JobEvent[] = [];
    bus.subscribe(execution.job.id, (event) => events.push(event));
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      bus,
      concurrency: 1,
      execute: async () => {
        started.resolve();
        await release.promise;
        return { status: "done", events: [{ type: "model_end", content: "not committed" }] };
      },
    });

    const run = worker.runOnce();
    await started.promise;
    await requestJobCancellation(db(), execution.job.id, 100);
    release.resolve();
    await run;

    expect(events).not.toContainEqual({ type: "model_end", content: "not committed" });
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "cancelled" });
  });

  it("claims once per slot up to configured concurrency", async () => {
    const executions = await Promise.all([createExecution("one"), createExecution("two"), createExecution("three")]);
    const bothStarted = deferred();
    const release = deferred();
    const workerIds: string[] = [];
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 2,
      processId: "test-process",
      execute: async (execution) => {
        workerIds.push(execution.attempt.workerId);
        if (workerIds.length === 2) bothStarted.resolve();
        await release.promise;
        return { status: "done" };
      },
    });

    const firstPass = worker.runOnce();
    await bothStarted.promise;
    expect(new Set(workerIds)).toEqual(new Set(["test-process:slot-0", "test-process:slot-1"]));
    expect(
      (await Promise.all(executions.map((execution) => getJobAttempt(db(), execution.attempt.id)))).filter(
        (attempt) => attempt?.status === "running",
      ),
    ).toHaveLength(2);

    release.resolve();
    expect(await firstPass).toBe(2);
    expect(await worker.runOnce()).toBe(1);
    expect(
      (await Promise.all(executions.map((execution) => getJobAttempt(db(), execution.attempt.id)))).map(
        (attempt) => attempt?.status,
      ),
    ).toEqual(["done", "done", "done"]);
  });

  it("settles executor failures and approval waits through the worker", async () => {
    const failed = await createExecution("fail");
    const failingWorker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      execute: async () => {
        throw new Error("provider exploded");
      },
    });
    await failingWorker.runOnce();
    expect(await getJob(db(), failed.job.id)).toMatchObject({ status: "failed", error: "provider exploded" });
    expect(await getJobAttempt(db(), failed.attempt.id)).toMatchObject({
      status: "failed",
      error: "provider exploded",
    });

    const waiting = await createExecution("approval");
    const waitingWorker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      execute: async () => ({ status: "waiting_approval" }),
    });
    await waitingWorker.runOnce();
    expect(await getJob(db(), waiting.job.id)).toMatchObject({ status: "waiting_approval" });
    expect(await getJobAttempt(db(), waiting.attempt.id)).toMatchObject({ status: "waiting_approval" });
  });

  it("heartbeats a long execution so its lease remains live", async () => {
    const execution = await createExecution("heartbeat");
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      leaseDurationMs: 150,
      heartbeatIntervalMs: 40,
      execute: async (_execution, context) => {
        await db().execute(sql`select pg_sleep(0.25)`);
        await context.assertLive();
        return { status: "done" };
      },
    });

    expect(await worker.runOnce()).toBe(1);
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "done" });
    expect((await getJobAttempt(db(), execution.attempt.id))?.lastHeartbeatAt?.getTime()).toBeGreaterThan(
      execution.attempt.createdAt.getTime(),
    );
  });

  it("marks expired work outcome unknown without retrying it", async () => {
    const execution = await createExecution("expired");
    // Keep the lease in the past but the execution deadline in the future so
    // this exercises an unexplained worker loss rather than a true timeout.
    const claimedAt = new Date(Date.now() - 200);
    await claimAttemptById(db(), execution.attempt.id, "dead-process:slot-0", 100, claimedAt);
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const worker = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1, execute });

    expect(await worker.recoverOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "outcome_unknown" });
    expect(await listJobAttempts(db(), execution.job.id)).toHaveLength(1);
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "outcome_unknown" });
  });

  it("fails the parent when a delegated child loses settlement ownership", async () => {
    const parent = await createExecution("parent");
    let childAttemptId: string | undefined;
    const childStarted = deferred();
    const releaseChild = deferred();
    const competingExecute = vi.fn(async () => ({ status: "done" as const }));
    const competitor = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      processId: "competitor",
      execute: competingExecute,
    });
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      execute: async (execution, context) => {
        if (execution.job.parentJobId) {
          childAttemptId = execution.attempt.id;
          childStarted.resolve();
          await releaseChild.promise;
          await db()
            .update(jobAttempts)
            .set({ leaseExpiresAt: new Date(0) })
            .where(eq(jobAttempts.id, execution.attempt.id));
          return { status: "done" };
        }
        await context.executeDelegatedChild({
          personaId: execution.job.personaId,
          prompt: "child",
          langgraphThreadId: randomUUID(),
        });
        return { status: "done" };
      },
    });

    const parentRun = worker.runOnce();
    await childStarted.promise;
    expect(await competitor.runOnce()).toBe(0);
    expect(competingExecute).not.toHaveBeenCalled();
    releaseChild.resolve();
    await parentRun;

    expect(childAttemptId).toBeDefined();
    if (!childAttemptId) throw new Error("child attempt was not created");
    expect(await getJob(db(), parent.job.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outcome is unknown"),
    });
    expect(await getJobAttempt(db(), childAttemptId)).toMatchObject({ status: "running" });
    expect(await worker.recoverOnce()).toBe(1);
    expect(await getJobAttempt(db(), childAttemptId)).toMatchObject({ status: "outcome_unknown" });
  });

  it("does not commit state after the executor loses its lease", async () => {
    const execution = await createExecution("stale state");
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      execute: async (claimed, context) => {
        await db()
          .update(jobAttempts)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(jobAttempts.id, claimed.attempt.id));
        await context.applyEffects([{ type: "write_persona_state", key: "stale", content: "must not commit" }]);
        return { status: "done" };
      },
    });

    await expect(worker.runOnce()).rejects.toThrow("lost its lease before settlement");
    expect(await db().select().from(personaState).where(eq(personaState.personaId, execution.job.personaId))).toEqual(
      [],
    );
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "running" });
  });

  it("does not forget_state or remember after the executor loses its lease", async () => {
    const execution = await createExecution("stale forget");
    await writeState(db(), execution.job.personaId, "inbox", "keep me");
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      execute: async (claimed, context) => {
        await db()
          .update(jobAttempts)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(jobAttempts.id, claimed.attempt.id));
        await context.applyEffects([
          { type: "delete_persona_state", key: "inbox" },
          {
            type: "remember_persona_memory",
            id: randomUUID(),
            personaId: claimed.job.personaId,
            label: "phantom",
            content: "must not land",
            sourceJobId: claimed.job.id,
            sensitivity: "normal",
            importance: 1,
          },
        ]);
        return { status: "done" };
      },
    });

    await expect(worker.runOnce()).rejects.toThrow("lost its lease before settlement");
    expect(await readState(db(), execution.job.personaId, "inbox")).toBe("keep me");
    expect(await listMemories(db(), execution.job.personaId)).toEqual([]);
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "running" });
  });

  it("publishes no approval event when terminal effects fail their lease fence", async () => {
    const execution = await createExecution("stale approval");
    const bus = new JobEventBus();
    const events: JobEvent[] = [];
    bus.subscribe(execution.job.id, (event) => events.push(event));
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      bus,
      concurrency: 1,
      execute: async (claimed) => {
        await db()
          .update(jobAttempts)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(jobAttempts.id, claimed.attempt.id));
        return {
          status: "waiting_approval",
          events: [{ type: "model_end", content: "must not publish" }],
          effects: [
            {
              type: "create_pending_tool_call",
              callId: "stale-call",
              toolId: "send_email",
              riskClass: "destructive",
              arguments: { to: "a@example.com" },
            },
          ],
        };
      },
    });

    await expect(worker.runOnce()).rejects.toThrow("outcome is unknown");
    expect(events).toEqual([{ type: "status", status: "running" }]);
    expect(await db().select().from(toolCalls).where(eq(toolCalls.jobId, execution.job.id))).toEqual([]);
  });

  it("preserves settlement invariant errors instead of reporting lease loss", async () => {
    const execution = await createExecution("settlement invariant");
    await createToolCall(db(), {
      jobId: execution.job.id,
      callId: "already-terminal",
      toolId: "send_email",
      riskClass: "destructive",
      arguments: { to: "a@example.com" },
      status: "executed",
      result: { sent: true },
    });
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      execute: async () => ({
        status: "waiting_approval",
        effects: [
          {
            type: "create_pending_tool_call",
            callId: "already-terminal",
            toolId: "send_email",
            riskClass: "destructive",
            arguments: { to: "a@example.com" },
          },
        ],
      }),
    });

    await expect(worker.runOnce()).rejects.toThrow("already executed");
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "running" });
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "running" });
  });

  it("publishes committed completion before awaiting webhook delivery", async () => {
    const execution = await createExecution("notify");
    process.env.NOTIFY_WEBHOOK_URL = "https://example.invalid/notify";
    const releaseWebhook = deferred<Response>();
    const webhookStarted = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        webhookStarted.resolve();
        return releaseWebhook.promise;
      }),
    );
    const bus = new JobEventBus();
    const events: JobEvent[] = [];
    bus.subscribe(execution.job.id, (event) => events.push(event));
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      bus,
      concurrency: 1,
      execute: async () => ({
        status: "done",
        events: [{ type: "model_end", content: "done" }],
        effects: [{ type: "insert_notification", message: "done", urgent: true }],
      }),
    });

    const running = worker.runOnce();
    await webhookStarted.promise;
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "done" });
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "model_end", content: "done" },
      { type: "status", status: "done" },
    ]);
    expect(await db().select().from(notifications).where(eq(notifications.jobId, execution.job.id))).toHaveLength(1);

    releaseWebhook.resolve(new Response(null, { status: 200 }));
    await running;
  });

  it("stop prevents another claim while drain waits for active execution", async () => {
    const first = await createExecution("first");
    const second = await createExecution("second");
    const started = deferred();
    const release = deferred();
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      pollIntervalMs: 10,
      recoveryIntervalMs: 10_000,
      execute: async () => {
        started.resolve();
        await release.promise;
        return { status: "done" };
      },
    });

    worker.start();
    await started.promise;
    worker.stop();
    const draining = worker.drain();
    release.resolve();
    await draining;

    const statuses = await db()
      .select({ jobId: jobAttempts.jobId, status: jobAttempts.status })
      .from(jobAttempts)
      .where(sql`${jobAttempts.jobId} in (${first.job.id}, ${second.job.id})`);
    expect(statuses.filter((attempt) => attempt.status === "done")).toHaveLength(1);
    expect(statuses.filter((attempt) => attempt.status === "queued")).toHaveLength(1);
  });

  it("rejects restart until stopped slot loops have drained", async () => {
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      pollIntervalMs: 10,
    });

    worker.start();
    worker.stop();
    expect(() => worker.start()).toThrow("drain");
    await worker.drain();
    expect(() => worker.start()).not.toThrow();
    worker.stop();
    await worker.drain();
  });

  it("releases a claim when stop wins while claim is blocked on the aggregate", async () => {
    const execution = await createExecution("blocked claim");
    const locked = deferred();
    const releaseLock = deferred();
    const holder = db().transaction(async (tx) => {
      await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, execution.job.id)).for("update");
      locked.resolve();
      await releaseLock.promise;
    });
    await locked.promise;

    const execute = vi.fn(async () => ({ status: "done" as const }));
    const worker = new JobWorker({
      db: db(),
      registry: defaultRegistry,
      concurrency: 1,
      pollIntervalMs: 10,
      execute,
    });
    worker.start();
    await db().execute(sql`select pg_sleep(0.05)`);
    worker.stop();
    releaseLock.resolve();
    await holder;
    await worker.drain();

    expect(execute).not.toHaveBeenCalled();
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "queued" });
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "queued", workerId: null });
  });

  it("commits forget_state through the default executor when the lease is live", async () => {
    vi.mocked(generateText).mockReset();
    const persona = await createPersona(db(), {
      name: "State owner",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "forget_state", permission: "allow" }],
    });
    await writeState(db(), persona.id, "inbox", "3 flagged");
    await createQueuedJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "user",
      prompt: "forget the inbox key",
      langgraphThreadId: randomUUID(),
    });
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ toolCallId: "c1", toolName: "forget_state", input: { key: "inbox" } }],
      } as any)
      .mockResolvedValueOnce({ text: "Forgotten.", toolCalls: [] } as any);

    const worker = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 });
    expect(await worker.runOnce()).toBe(1);
    expect(await readState(db(), persona.id, "inbox")).toBe("");
  });

  // Every other delegation test above overrides `execute`, so it exercises
  // executeDelegatedChild/createClaimedChild's lease/cancellation mechanics
  // directly and never touches dispatcher.ts's real onDelegate at all. This
  // one uses the worker's *default* execute (executeClaimedExecution ->
  // driveTurn), the actual production path, to prove the fold really
  // reaches the model through the full worker/attempt machinery -- not just
  // through the no-worker fallback path delegation.test.ts covers.
  it("folds a delegated child's real result back to the parent through the default executor", async () => {
    vi.mocked(generateText).mockReset();
    const principal = await createPersona(db(), {
      name: "Principal",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      // Unassigned tools are Blocked — this test actually invokes delegate_to.
      assignedToolIds: [{ toolId: "delegate_to", permission: "allow" }],
    });
    const finance = await createPersona(db(), {
      name: "Finance",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const parent = await createQueuedJob(db(), {
      personaId: principal.id,
      depth: 0,
      origin: "user",
      prompt: "handle my finances",
      langgraphThreadId: randomUUID(),
    });

    vi.mocked(generateText)
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          { toolCallId: "call_1", toolName: "delegate_to", input: { personaId: finance.id, task: "check finances" } },
        ],
      } as any)
      .mockResolvedValueOnce({ text: "Finances look fine.", toolCalls: [] } as any) // the child's own turn
      .mockResolvedValueOnce({ text: "Delegated: finances look fine.", toolCalls: [] } as any); // the parent's fold

    const worker = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 });
    expect(await worker.runOnce()).toBe(1);

    const parentJob = await getJob(db(), parent.job.id);
    expect(parentJob).toMatchObject({ status: "done" });
    expect(await getLastAssistantMessage(db(), parent.job.id)).toMatchObject({
      role: "assistant",
      content: "Delegated: finances look fine.",
    });

    const children = await db().select().from(jobs).where(eq(jobs.parentJobId, parent.job.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ personaId: finance.id, depth: 1, status: "done" });

    const foldCallArgs = vi.mocked(generateText).mock.calls[2]![0] as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const toolResultMessage = foldCallArgs.messages.find((m) => m.role === "tool");
    const parts = toolResultMessage!.content as Array<{
      output: { type: "json"; value: { delegated: boolean; result?: string } };
    }>;
    expect(parts[0]!.output.value.delegated).toBe(true);
    expect(parts[0]!.output.value.result).toBe("Finances look fine.");
  });
});
