import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { getJob } from "../src/jobs/job-repo.js";
import { listMessagesByJob } from "../src/jobs/message-repo.js";
import {
  abandonExpiredAttempts,
  applyAttemptEffects,
  assertLiveAttempt,
  beginExternalAttemptEffect,
  completeExternalAttemptEffect,
  claimAttemptById,
  claimNextAttempt,
  createQueuedJob,
  createClaimedChild,
  enqueueApprovalResume,
  enqueueContinuation,
  enqueueRetry,
  evaluateRetryEligibility,
  getJobAttempt,
  getRetryEligibility,
  heartbeatAttempt,
  heartbeatAttemptControl,
  listJobAttempts,
  settleAttempt,
  requestJobCancellation,
} from "../src/jobs/job-attempt-repo.js";
import { createToolCall, getToolCall } from "../src/tool-calls/tool-call-repo.js";
import {
  jobAttempts,
  jobs,
  messages,
  notifications,
  personaState,
  personas,
  routines,
  toolCalls,
  type JobAttemptRow,
  type JobRow,
  type ToolCallRow,
} from "../src/db/schema.js";
import { eq, sql } from "drizzle-orm";
import { createRoutine, deleteRoutine } from "../src/personas/routine-repo.js";
import { writeState, readState } from "../src/personas/persona-state-repo.js";
import { listMemories, rememberMemory } from "../src/personas/persona-memory-repo.js";
import { buildPushPayload } from "../src/notifications/notify.js";

const { db } = useTestDb();

async function createTestExecution(prompt = "hello", messageAt?: Date, notifyOnOutcome = false, name = "A") {
  const persona = await createPersona(db(), {
    name,
    role: "R",
    systemPrompt: "S",
    voiceNotes: "",
    boundaries: "",
    scopeDescription: "",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  const execution = await createQueuedJob(db(), {
    personaId: persona.id,
    depth: 0,
    origin: "user",
    prompt,
    messageAt,
    notifyOnOutcome,
    langgraphThreadId: randomUUID(),
  });
  return { persona, execution };
}

describe("job attempt queue and leases", () => {
  it("creates the aggregate job and durable typed input together", async () => {
    const { execution } = await createTestExecution("remember this exact prompt");

    expect(execution.job.status).toBe("queued");
    expect(execution.attempt).toMatchObject({
      jobId: execution.job.id,
      sequence: 1,
      status: "queued",
      input: { type: "user_message", content: "remember this exact prompt" },
      notifyOnOutcome: false,
    });
  });

  it("persists explicit notification intent on the individual attempt", async () => {
    const { execution } = await createTestExecution("report back", undefined, true);

    expect(execution.attempt.notifyOnOutcome).toBe(true);
  });

  it("creates an outcome notification inside opted-in completion settlement", async () => {
    const { execution } = await createTestExecution("report back", undefined, true);
    const now = new Date("2026-08-26T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      {
        status: "done",
        effects: [{ type: "append_assistant_message", content: "The report is ready.", at: now }],
      },
      new Date(now.getTime() + 1),
    );

    expect(settled?.applied.notifications).toHaveLength(1);
    expect(settled?.applied.notifications[0]).toMatchObject({
      jobId: execution.job.id,
      kind: "job_finished",
      title: "Finished",
      pushOverride: true,
      message: expect.stringContaining("The report is ready."),
    });
  });

  it("creates an outcome notification inside opted-in failure settlement", async () => {
    const { execution } = await createTestExecution("report back", undefined, true);
    const now = new Date("2026-08-26T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      { status: "failed", error: "provider exploded" },
      new Date(now.getTime() + 1),
    );

    expect(settled?.applied.notifications).toHaveLength(1);
    expect(settled?.applied.notifications[0]).toMatchObject({
      jobId: execution.job.id,
      kind: "job_failed",
      title: "Failed",
      urgent: true,
      message: expect.stringMatching(/failed.*provider exploded/i),
    });
  });

  it("keeps an unselected completion silent", async () => {
    const { execution } = await createTestExecution("report back");
    const now = new Date("2026-08-26T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    const settled = await settleAttempt(db(), execution.attempt.id, "worker-a", { status: "done" }, now);

    expect(settled?.applied.notifications).toEqual([]);
  });

  it("notifies on approval pause even when notifyOnOutcome is false", async () => {
    const { persona, execution } = await createTestExecution("needs a signature");
    const now = new Date("2026-08-27T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    expect(execution.attempt.notifyOnOutcome).toBe(false);
    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      {
        status: "waiting_approval",
        effects: [
          {
            type: "create_pending_tool_call",
            callId: "call-approval",
            toolId: "send_email",
            riskClass: "destructive",
            arguments: { to: "a@example.com" },
          },
        ],
      },
      new Date(now.getTime() + 1),
    );

    expect(settled?.applied.notifications).toHaveLength(1);
    expect(settled?.applied.notifications[0]).toMatchObject({
      jobId: execution.job.id,
      personaId: persona.id,
      kind: "approval_needed",
      title: "Approval needed · send_email",
      toolCallId: settled?.applied.toolCalls[0]?.id,
      urgent: true,
      waitingApproval: true,
      message: "A is waiting for approval to use send_email.",
    });
    expect(await db().select().from(notifications).where(eq(notifications.jobId, execution.job.id))).toHaveLength(1);
  });

  it("opens /approvals for a real pause even when the persona name and tool id contain periods", async () => {
    const { execution } = await createTestExecution("needs a signature", undefined, false, "Dr. Smith");
    const now = new Date("2026-08-27T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      {
        status: "waiting_approval",
        effects: [
          {
            type: "create_pending_tool_call",
            callId: "call-approval",
            toolId: "mcp.gmail/send_email",
            riskClass: "destructive",
            arguments: { to: "a@example.com" },
          },
        ],
      },
      new Date(now.getTime() + 1),
    );

    const notification = settled?.applied.notifications[0];
    expect(notification).toMatchObject({
      waitingApproval: true,
      message: "Dr. Smith is waiting for approval to use mcp.gmail/send_email.",
    });
    expect(buildPushPayload(notification!)).toMatchObject({
      title: "RetinueOS — approval needed",
      body: "Dr. Smith is waiting for approval to use mcp.gmail/send_email.",
      path: "/approvals",
    });
  });

  it("sends an opted-in completion back to the job's chat when the summary mentions a pause", async () => {
    const { execution } = await createTestExecution("report back", undefined, true);
    const now = new Date("2026-08-27T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      {
        status: "done",
        effects: [
          {
            type: "append_assistant_message",
            content: "Delegate is waiting for approval to use send_email.",
            at: now,
          },
        ],
      },
      new Date(now.getTime() + 1),
    );

    const notification = settled?.applied.notifications[0];
    expect(notification).toMatchObject({
      waitingApproval: false,
      message: "A finished. Delegate is waiting for approval to use send_email.",
    });
    expect(buildPushPayload(notification!)).toMatchObject({
      title: "RetinueOS",
      body: "A finished. Delegate is waiting for approval to use send_email.",
      path: `/roster/${execution.job.personaId}?chat=${execution.job.id}`,
    });
  });

  it("creates a single approval notification when the attempt also opted in", async () => {
    const { execution } = await createTestExecution("needs a signature", undefined, true);
    const now = new Date("2026-08-27T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      {
        status: "waiting_approval",
        effects: [
          {
            type: "create_pending_tool_call",
            callId: "call-approval",
            toolId: "send_email",
            riskClass: "destructive",
            arguments: {},
          },
        ],
      },
      new Date(now.getTime() + 1),
    );

    expect(settled?.applied.notifications).toHaveLength(1);
  });

  it("lets exactly one concurrent worker claim an attempt", async () => {
    const { execution } = await createTestExecution();
    const now = new Date("2026-08-22T12:00:00.000Z");

    const claims = await Promise.all([
      claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now),
      claimAttemptById(db(), execution.attempt.id, "worker-b", 30_000, now),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await getJob(db(), execution.job.id))?.status).toBe("running");
    expect((await getJobAttempt(db(), execution.attempt.id))?.status).toBe("running");
  });

  it("rejects an empty worker incarnation id without claiming", async () => {
    const { execution } = await createTestExecution();

    await expect(claimAttemptById(db(), execution.attempt.id, "  ")).rejects.toThrow("worker id must not be empty");
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "queued", workerId: null });
  });

  it("rolls back the attempt claim when its aggregate job is not queued", async () => {
    const { execution } = await createTestExecution();
    await db().update(jobs).set({ status: "failed" }).where(eq(jobs.id, execution.job.id));

    expect(await claimAttemptById(db(), execution.attempt.id, "worker-a")).toBeUndefined();
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "queued", workerId: null });
    expect(await enqueueContinuation(db(), execution.job.id, "must not overtake queued work")).toBeUndefined();
  });

  it("uses skip-locked claiming so concurrent workers take distinct jobs", async () => {
    const first = await createTestExecution("first");
    const second = await createTestExecution("second");
    const now = new Date("2026-08-22T12:00:00.000Z");

    const claims = await Promise.all([
      claimNextAttempt(db(), "worker-a", 30_000, now),
      claimNextAttempt(db(), "worker-b", 30_000, now),
    ]);

    expect(new Set(claims.map((claim) => claim?.attempt.id))).toEqual(
      new Set([first.execution.attempt.id, second.execution.attempt.id]),
    );
  });

  it("does not let an inconsistent queued attempt starve later work", async () => {
    const inconsistent = await createTestExecution("inconsistent");
    const valid = await createTestExecution("valid");
    await db().update(jobs).set({ status: "failed" }).where(eq(jobs.id, inconsistent.execution.job.id));

    const claim = await claimNextAttempt(db(), "worker-a");

    expect(claim?.attempt.id).toBe(valid.execution.attempt.id);
    expect(await getJobAttempt(db(), inconsistent.execution.attempt.id)).toMatchObject({ status: "queued" });
  });

  it("heartbeats only a live lease owned by the same worker", async () => {
    const { execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt);

    expect(
      await heartbeatAttempt(db(), execution.attempt.id, "worker-b", 1_000, new Date(claimedAt.getTime() + 500)),
    ).toBe(false);
    expect(
      await heartbeatAttempt(db(), execution.attempt.id, "worker-a", 1_000, new Date(claimedAt.getTime() + 500)),
    ).toBe(true);
    expect(await assertLiveAttempt(db(), execution.attempt.id, "worker-a", new Date(claimedAt.getTime() + 1_499))).toBe(
      true,
    );
    expect(
      await heartbeatAttempt(db(), execution.attempt.id, "worker-a", 1_000, new Date(claimedAt.getTime() + 1_500)),
    ).toBe(false);
  });

  it("settles the attempt and aggregate job atomically through the live fence", async () => {
    const { execution } = await createTestExecution();
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);

    expect(await settleAttempt(db(), execution.attempt.id, "worker-b", { status: "done" }, now)).toBeUndefined();
    const settled = await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      { status: "done" },
      new Date(now.getTime() + 1),
    );

    expect(settled?.status).toBe("done");
    expect((await getJob(db(), execution.job.id))?.status).toBe("done");
  });

  it("refuses settlement after the lease expires", async () => {
    const { execution } = await createTestExecution();
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, now);

    expect(
      await settleAttempt(db(), execution.attempt.id, "worker-a", { status: "done" }, new Date(now.getTime() + 1_000)),
    ).toBeUndefined();
    expect((await getJob(db(), execution.job.id))?.status).toBe("running");
    expect((await getJobAttempt(db(), execution.attempt.id))?.status).toBe("running");
  });

  it("fences in-flight effects by worker and live lease", async () => {
    const { persona, execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt);
    const lease = { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 1_000 };
    const effect = { type: "write_persona_state", key: "inbox", content: "owned" } as const;

    expect(
      await applyAttemptEffects(db(), { ...lease, workerId: "worker-b" }, [effect], new Date(claimedAt.getTime() + 1)),
    ).toBeUndefined();
    expect(await applyAttemptEffects(db(), lease, [effect], new Date(claimedAt.getTime() + 1_000))).toBeUndefined();
    expect(await db().select().from(personaState).where(eq(personaState.personaId, persona.id))).toEqual([]);

    const applied = await applyAttemptEffects(db(), lease, [effect], new Date(claimedAt.getTime() + 500));
    expect(applied?.personaState).toHaveLength(1);
    expect(applied?.personaState[0]?.updatedAt).toEqual(new Date(claimedAt.getTime() + 500));
    expect((await getJobAttempt(db(), execution.attempt.id))?.leaseExpiresAt).toEqual(
      new Date(claimedAt.getTime() + 1_500),
    );
  });

  it("refuses forget_state and memory writes from a stale or foreign lease", async () => {
    const { persona, execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt);
    await writeState(db(), persona.id, "inbox", "keep me");
    await rememberMemory(db(), { personaId: persona.id, label: "pref", content: "keep this fact" });
    const lease = { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 1_000 };
    const memoryId = randomUUID();
    const staleDeletes = [
      { type: "delete_persona_state", key: "inbox" } as const,
      { type: "forget_persona_memory", personaId: persona.id, label: "pref" } as const,
    ];
    const staleRemember = {
      type: "remember_persona_memory",
      id: memoryId,
      personaId: persona.id,
      label: "phantom",
      content: "must not land",
      sourceJobId: execution.job.id,
      sensitivity: "normal",
      importance: 1,
    } as const;

    expect(
      await applyAttemptEffects(
        db(),
        { ...lease, workerId: "worker-b" },
        staleDeletes,
        new Date(claimedAt.getTime() + 1),
      ),
    ).toBeUndefined();
    expect(
      await applyAttemptEffects(db(), lease, [staleRemember], new Date(claimedAt.getTime() + 1_000)),
    ).toBeUndefined();
    expect(await readState(db(), persona.id, "inbox")).toBe("keep me");
    expect(await listMemories(db(), persona.id)).toHaveLength(1);

    expect(await applyAttemptEffects(db(), lease, staleDeletes, new Date(claimedAt.getTime() + 500))).toBeDefined();
    expect(await readState(db(), persona.id, "inbox")).toBe("");
    expect(await listMemories(db(), persona.id)).toHaveLength(0);
  });

  it("does not apply forget_state after the operator cancels the attempt", async () => {
    const { persona, execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, claimedAt);
    await writeState(db(), persona.id, "inbox", "keep me");
    await requestJobCancellation(db(), execution.job.id, 100, new Date(claimedAt.getTime() + 1));

    const applied = await applyAttemptEffects(
      db(),
      { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 30_000 },
      [{ type: "delete_persona_state", key: "inbox" }],
      new Date(claimedAt.getTime() + 2),
    );
    expect(applied).toBeUndefined();
    expect(await readState(db(), persona.id, "inbox")).toBe("keep me");
  });

  it("settles approval effects and aggregate status in one transaction", async () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const { execution } = await createTestExecution("hello", new Date(now.getTime() - 1));
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);
    const outcome = {
      status: "waiting_approval",
      effects: [
        {
          type: "create_pending_tool_call",
          callId: "call-approval",
          toolId: "send_email",
          riskClass: "destructive",
          arguments: { to: "a@example.com" },
        },
        { type: "append_assistant_message", content: "I need approval.", at: new Date(now.getTime() + 1) },
      ],
    } as const;

    expect(await settleAttempt(db(), execution.attempt.id, "worker-b", outcome, now)).toBeUndefined();
    expect(await db().select().from(toolCalls).where(eq(toolCalls.jobId, execution.job.id))).toEqual([]);
    expect(await listMessagesByJob(db(), execution.job.id)).toHaveLength(1);

    const settled = await settleAttempt(db(), execution.attempt.id, "worker-a", outcome, new Date(now.getTime() + 2));
    expect(settled?.status).toBe("waiting_approval");
    expect(settled?.applied.toolCalls).toHaveLength(1);
    expect((await listMessagesByJob(db(), execution.job.id)).map((m) => m.content)).toEqual([
      "hello",
      "I need approval.",
    ]);
  });

  it("settles completion summaries, messages, and notification atomically", async () => {
    const persona = await createPersona(db(), {
      name: "Routine persona",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Digest",
      cronSchedule: "0 9 * * *",
      promptTemplate: "summarize",
      notifyRoutineRan: true,
    });
    const execution = await createQueuedJob(db(), {
      personaId: persona.id,
      routineId: routine.id,
      depth: 0,
      origin: "cron",
      prompt: "summarize",
      langgraphThreadId: randomUUID(),
    });
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);
    const outcome = {
      status: "done",
      effects: [
        { type: "set_persona_summary", content: "All clear." },
        { type: "append_assistant_message", content: "All clear.", at: new Date(now.getTime() + 1) },
        { type: "set_routine_summary", routineId: routine.id, content: "All clear." },
        { type: "insert_notification", routineId: routine.id, message: "Digest: All clear.", urgent: true },
      ],
    } as const;

    expect(await settleAttempt(db(), execution.attempt.id, "worker-b", outcome, now)).toBeUndefined();
    expect((await db().select().from(personas).where(eq(personas.id, persona.id)))[0]?.lastSummary).toBe("");
    expect(await db().select().from(notifications).where(eq(notifications.jobId, execution.job.id))).toEqual([]);

    const settled = await settleAttempt(db(), execution.attempt.id, "worker-a", outcome, new Date(now.getTime() + 2));
    expect(settled?.job.status).toBe("done");
    expect(settled?.applied.notifications).toHaveLength(1);
    expect(settled?.applied.notifications[0]).toMatchObject({ kind: "job_finished", title: "Finished" });
    expect((await db().select().from(personas).where(eq(personas.id, persona.id)))[0]?.lastSummary).toBe("All clear.");
    expect((await db().select().from(routines).where(eq(routines.id, routine.id)))[0]?.lastSummary).toBe("All clear.");
    expect((await db().select().from(routines).where(eq(routines.id, routine.id)))[0]?.lastFiredAt).toEqual(
      new Date(now.getTime() + 2),
    );
  });

  it("does not overwrite a terminal tool audit on replay", async () => {
    const { persona, execution } = await createTestExecution();
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);
    const lease = { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 30_000 };
    const effect = {
      type: "record_tool_result",
      callId: "call-read",
      toolId: "get_weather",
      riskClass: "read_only",
      arguments: { city: "Boston" },
      result: { conditions: "clear" },
      status: "executed",
      gated: false,
    } as const;
    await applyAttemptEffects(db(), lease, [effect], new Date(now.getTime() + 1));

    await expect(
      applyAttemptEffects(
        db(),
        lease,
        [
          { type: "write_persona_state", key: "audit-race", content: "must roll back" },
          { ...effect, result: { conditions: "storm" } },
        ],
        new Date(now.getTime() + 2),
      ),
    ).rejects.toThrow("already terminal");
    expect((await db().select().from(toolCalls).where(eq(toolCalls.jobId, execution.job.id)))[0]).toMatchObject({
      result: { conditions: "clear" },
      jobAttemptId: execution.attempt.id,
    });
    expect(await db().select().from(personaState).where(eq(personaState.personaId, persona.id))).toEqual([]);
  });

  it("serializes routine deletion with attempt settlement in job-then-routine order", async () => {
    const persona = await createPersona(db(), {
      name: "Routine owner",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Concurrent",
      cronSchedule: "0 9 * * *",
      promptTemplate: "run",
    });
    const execution = await createQueuedJob(db(), {
      personaId: persona.id,
      routineId: routine.id,
      depth: 0,
      origin: "cron",
      prompt: "run",
      langgraphThreadId: randomUUID(),
    });
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000);

    const [settled] = await Promise.all([
      settleAttempt(db(), execution.attempt.id, "worker-a", {
        status: "done",
        effects: [{ type: "set_routine_summary", routineId: routine.id, content: "complete" }],
      }),
      deleteRoutine(db(), routine.id),
    ]);

    expect(settled?.status).toBe("done");
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "done", routineId: null });
  });

  it("settles successfully and suppresses stale routine effects when deletion wins", async () => {
    const persona = await createPersona(db(), {
      name: "Deleted routine owner",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const routine = await createRoutine(db(), {
      personaId: persona.id,
      name: "Deleted before settlement",
      cronSchedule: "0 9 * * *",
      promptTemplate: "run",
      notifyRoutineRan: true,
    });
    const execution = await createQueuedJob(db(), {
      personaId: persona.id,
      routineId: routine.id,
      depth: 0,
      origin: "cron",
      prompt: "run",
      langgraphThreadId: randomUUID(),
    });
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000);
    await deleteRoutine(db(), routine.id);

    const settled = await settleAttempt(db(), execution.attempt.id, "worker-a", {
      status: "done",
      effects: [
        { type: "set_routine_summary", routineId: routine.id, content: "stale" },
        { type: "insert_notification", routineId: routine.id, message: "stale", urgent: true },
      ],
    });

    expect(settled?.status).toBe("done");
    expect(settled?.applied.notifications).toEqual([]);
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "done", routineId: null });
    expect(await db().select().from(notifications).where(eq(notifications.jobId, execution.job.id))).toEqual([]);
  });

  it("creates a delegated child under the live parent fence", async () => {
    const { execution } = await createTestExecution("parent", undefined, true);
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, now);
    const input = { personaId: execution.job.personaId, prompt: "child", langgraphThreadId: randomUUID() };

    expect(
      await createClaimedChild(
        db(),
        { attemptId: execution.attempt.id, workerId: "worker-b", leaseDurationMs: 1_000 },
        input,
        new Date(now.getTime() + 1),
      ),
    ).toBeUndefined();
    expect(await db().select().from(jobs).where(eq(jobs.parentJobId, execution.job.id))).toEqual([]);

    const child = await createClaimedChild(
      db(),
      { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 1_000 },
      input,
      new Date(now.getTime() + 2),
    );
    expect(child?.job).toMatchObject({
      parentJobId: execution.job.id,
      depth: 1,
      origin: "delegation",
      status: "running",
    });
    expect(child?.attempt).toMatchObject({ status: "running", workerId: "worker-a", notifyOnOutcome: false });
    expect(await claimNextAttempt(db(), "worker-b", 1_000, new Date(now.getTime() + 3))).toBeUndefined();
  });

  it("rechecks the real database clock after waiting for the attempt lock", async () => {
    const { execution } = await createTestExecution();
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000);

    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx
        .select({ id: jobAttempts.id })
        .from(jobAttempts)
        .where(eq(jobAttempts.id, execution.attempt.id))
        .for("update");
      reportLocked();
      await tx.execute(sql`
          select pg_sleep(
            (greatest(0, extract(epoch from (${jobAttempts.leaseExpiresAt} - clock_timestamp()))) + 0.1)::double precision
          )
          from ${jobAttempts}
          where ${jobAttempts.id} = ${execution.attempt.id}
        `);
    });

    await locked;
    expect(await assertLiveAttempt(db(), execution.attempt.id, "worker-a")).toBe(true);
    const settlement = settleAttempt(db(), execution.attempt.id, "worker-a", { status: "done" });

    await holder;
    expect(await settlement).toBeUndefined();
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "running" });
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "running" });
  }, 3_000);

  it("rolls back effects when their transaction crosses the lease deadline after locking the attempt", async () => {
    const { execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    const toolCall = await createToolCall(db(), {
      jobId: execution.job.id,
      callId: "blocked-call",
      toolId: "send_email",
      riskClass: "destructive",
      arguments: { to: "a@example.com" },
      status: "approved",
    });
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt);

    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx.select().from(toolCalls).where(eq(toolCalls.id, toolCall.id)).for("update");
      reportLocked();
      await tx.execute(sql`select pg_sleep(0.05)`);
    });
    await locked;

    const applying = applyAttemptEffects(
      db(),
      { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 1_000 },
      [
        {
          type: "record_tool_result",
          callId: "blocked-call",
          toolId: "send_email",
          riskClass: "destructive",
          arguments: { to: "a@example.com" },
          result: { sent: true },
          status: "executed",
          gated: true,
        },
      ],
      new Date(claimedAt.getTime() + 1),
      new Date(claimedAt.getTime() + 1_000),
    );
    await holder;

    expect(await applying).toBeUndefined();
    expect(await getToolCall(db(), toolCall.id)).toMatchObject({ status: "approved", result: null });
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "running" });
  }, 3_000);

  it("rolls back terminal effects when settlement crosses the lease deadline", async () => {
    const { persona, execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt);
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx.select().from(personas).where(eq(personas.id, persona.id)).for("update");
      reportLocked();
      await tx.execute(sql`select pg_sleep(0.05)`);
    });
    await locked;

    const settlement = settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      {
        status: "done",
        effects: [{ type: "set_persona_summary", content: "must roll back" }],
      },
      new Date(claimedAt.getTime() + 1),
      new Date(claimedAt.getTime() + 1_000),
    );
    await holder;

    expect(await settlement).toBeUndefined();
    expect((await db().select().from(personas).where(eq(personas.id, persona.id)))[0]?.lastSummary).toBe("");
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "running" });
  }, 3_000);

  it("rolls back a delegated child when creation crosses the parent lease deadline", async () => {
    const parent = await createTestExecution("parent");
    const childPersona = await createPersona(db(), {
      name: "Child",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), parent.execution.attempt.id, "worker-a", 1_000, claimedAt);
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const holder = db().transaction(async (tx) => {
      await tx.select().from(personas).where(eq(personas.id, childPersona.id)).for("update");
      reportLocked();
      await tx.execute(sql`select pg_sleep(0.05)`);
    });
    await locked;

    const creation = createClaimedChild(
      db(),
      { attemptId: parent.execution.attempt.id, workerId: "worker-a", leaseDurationMs: 1_000 },
      { personaId: childPersona.id, prompt: "child", langgraphThreadId: randomUUID() },
      new Date(claimedAt.getTime() + 1),
      new Date(claimedAt.getTime() + 1_000),
    );
    await holder;

    expect(await creation).toBeUndefined();
    expect(await db().select().from(jobs).where(eq(jobs.parentJobId, parent.execution.job.id))).toEqual([]);
  }, 3_000);

  it("queues one concurrent continuation with the exact prompt and next sequence", async () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const { execution } = await createTestExecution("hello", new Date(now.getTime() - 1));
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);
    await settleAttempt(db(), execution.attempt.id, "worker-a", { status: "done" }, new Date(now.getTime() + 1));

    const continuations = await Promise.all([
      enqueueContinuation(db(), execution.job.id, "first continuation", {
        notifyOnOutcome: true,
        at: new Date(now.getTime() + 2),
      }),
      enqueueContinuation(db(), execution.job.id, "second continuation", {
        notifyOnOutcome: true,
        at: new Date(now.getTime() + 2),
      }),
    ]);
    const winner = continuations.find(Boolean)!;

    expect(continuations.filter(Boolean)).toHaveLength(1);
    expect(winner.attempt.sequence).toBe(2);
    expect(winner.attempt.notifyOnOutcome).toBe(true);
    const winningContent = winner.attempt.input.type === "user_message" ? winner.attempt.input.content : undefined;
    const updated = await getJob(db(), execution.job.id);
    expect(updated?.status).toBe("queued");
    const messageRows = await listMessagesByJob(db(), execution.job.id);
    expect(messageRows).toHaveLength(2);
    expect(winningContent).toBe(messageRows[1]?.content);
    expect(["first continuation", "second continuation"]).toContain(winningContent);
  });

  it("resolves approval and enqueues its resume in one transaction", async () => {
    const { execution } = await createTestExecution("needs approval", undefined, true);
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);
    await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      { status: "waiting_approval" },
      new Date(now.getTime() + 1),
    );
    const toolCall = await createToolCall(db(), {
      jobId: execution.job.id,
      toolId: "send_email",
      riskClass: "destructive",
      arguments: {},
    });

    const queued = await enqueueApprovalResume(db(), toolCall.id, true);

    expect(queued?.job.status).toBe("queued");
    expect(queued?.attempt).toMatchObject({
      sequence: 2,
      status: "queued",
      notifyOnOutcome: true,
      input: { type: "approval_resume", toolCallId: toolCall.id, approved: true },
    });
    expect((await getToolCall(db(), toolCall.id))?.status).toBe("approved");
  });

  it("lets exactly one concurrent approve/reject publish a resume attempt", async () => {
    const { execution } = await createTestExecution();
    const now = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 30_000, now);
    await settleAttempt(
      db(),
      execution.attempt.id,
      "worker-a",
      { status: "waiting_approval" },
      new Date(now.getTime() + 1),
    );
    const toolCall = await createToolCall(db(), {
      jobId: execution.job.id,
      toolId: "send_email",
      riskClass: "destructive",
      arguments: {},
    });

    const resolutions = await Promise.all([
      enqueueApprovalResume(db(), toolCall.id, true),
      enqueueApprovalResume(db(), toolCall.id, false),
    ]);
    const winner = resolutions.find(Boolean)!;

    expect(resolutions.filter(Boolean)).toHaveLength(1);
    expect(winner.attempt.input).toEqual({
      type: "approval_resume",
      toolCallId: toolCall.id,
      approved: winner.toolCall.status === "approved",
    });
    expect(await listJobAttempts(db(), execution.job.id)).toHaveLength(2);
  });

  it("records expired work as outcome unknown without creating a retry and is idempotent", async () => {
    const { execution } = await createTestExecution("recover me", undefined, true);
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt);

    const abandoned = await abandonExpiredAttempts(db(), new Date(claimedAt.getTime() + 1_000));

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.status).toBe("outcome_unknown");
    expect(abandoned[0]?.notifications).toHaveLength(1);
    expect(abandoned[0]?.notifications[0]).toMatchObject({ jobId: execution.job.id });
    const job = await getJob(db(), execution.job.id);
    expect(job?.status).toBe("outcome_unknown");
    expect(job?.error).toContain("was not retried");
    expect(await listJobAttempts(db(), execution.job.id)).toHaveLength(1);
    expect(await abandonExpiredAttempts(db(), new Date(claimedAt.getTime() + 2_000))).toEqual([]);
    expect(await enqueueContinuation(db(), execution.job.id, "unsafe follow-up")).toBeUndefined();
  });

  it("classifies an expired attempt past its deadline as timed out", async () => {
    const { execution } = await createTestExecution("stalled past deadline");
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 1_000, claimedAt, 500);

    await abandonExpiredAttempts(db(), new Date(claimedAt.getTime() + 1_000));

    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ status: "timed_out" });
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "timed_out" });
  });

  it("quarantines an inconsistent expired attempt without blocking valid recovery", async () => {
    const inconsistent = await createTestExecution("inconsistent");
    const valid = await createTestExecution("valid");
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    await claimAttemptById(db(), inconsistent.execution.attempt.id, "worker-a", 1_000, claimedAt);
    await claimAttemptById(db(), valid.execution.attempt.id, "worker-b", 1_000, claimedAt);
    await db().update(jobs).set({ status: "done" }).where(eq(jobs.id, inconsistent.execution.job.id));

    const abandoned = await abandonExpiredAttempts(db(), new Date(claimedAt.getTime() + 1_000));

    expect(new Set(abandoned.map((attempt) => attempt.id))).toEqual(
      new Set([inconsistent.execution.attempt.id, valid.execution.attempt.id]),
    );
    expect(await getJobAttempt(db(), inconsistent.execution.attempt.id)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(await getJob(db(), inconsistent.execution.job.id)).toMatchObject({ status: "done" });
    expect(await getJobAttempt(db(), valid.execution.attempt.id)).toMatchObject({ status: "outcome_unknown" });
    expect(await getJob(db(), valid.execution.job.id)).toMatchObject({
      status: "outcome_unknown",
      error: expect.stringContaining("was not retried"),
    });
  });

  it("starts the execution deadline at claim and requests timeout at the exact boundary", async () => {
    const { execution } = await createTestExecution();
    const claimedAt = new Date("2026-08-22T12:00:00.000Z");
    const claimed = await claimAttemptById(db(), execution.attempt.id, "worker-a", 5_000, claimedAt, 1_000);

    expect(claimed?.attempt.deadlineAt).toEqual(new Date(claimedAt.getTime() + 1_000));
    expect(
      await heartbeatAttemptControl(
        db(),
        execution.attempt.id,
        "worker-a",
        5_000,
        250,
        new Date(claimedAt.getTime() + 999),
      ),
    ).toEqual({ live: true });
    const control = await heartbeatAttemptControl(
      db(),
      execution.attempt.id,
      "worker-a",
      5_000,
      250,
      new Date(claimedAt.getTime() + 1_000),
    );
    expect(control).toMatchObject({ live: true, abort: { reason: "deadline" } });
    expect(await getJob(db(), execution.job.id)).toMatchObject({ status: "cancelling" });
    const afterGrace = await heartbeatAttemptControl(
      db(),
      execution.attempt.id,
      "worker-a",
      5_000,
      250,
      new Date(claimedAt.getTime() + 1_251),
    );
    expect(afterGrace).toMatchObject({ live: false, abort: { reason: "deadline" } });
  });

  it("cancels queued and approval-waiting attempts without creating a resume", async () => {
    const queued = await createTestExecution("queued cancellation", undefined, true);
    const queuedResult = await requestJobCancellation(
      db(),
      queued.execution.job.id,
      100,
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(queuedResult?.job.status).toBe("cancelled");
    expect(queuedResult?.attempt?.status).toBe("cancelled");
    expect(queuedResult?.notifications).toHaveLength(1);
    expect(queuedResult?.notifications[0]).toMatchObject({ jobId: queued.execution.job.id });

    const waiting = await createTestExecution("approval cancellation");
    const claimedAt = new Date("2026-08-22T12:01:00Z");
    await claimAttemptById(db(), waiting.execution.attempt.id, "worker-a", 30_000, claimedAt);
    const settled = await settleAttempt(
      db(),
      waiting.execution.attempt.id,
      "worker-a",
      {
        status: "waiting_approval",
        effects: [
          {
            type: "create_pending_tool_call",
            callId: "cancelled-call",
            toolId: "send_email",
            riskClass: "destructive",
            arguments: { to: "a@example.com" },
          },
        ],
      },
      new Date(claimedAt.getTime() + 1),
    );
    const toolCall = settled?.applied.toolCalls[0];
    expect(toolCall).toBeDefined();
    await requestJobCancellation(db(), waiting.execution.job.id, 100, new Date(claimedAt.getTime() + 2));
    expect(await getToolCall(db(), toolCall!.id)).toMatchObject({ status: "cancelled" });
    expect(await enqueueApprovalResume(db(), toolCall!.id, true)).toBeUndefined();
  });

  it("classifies running cancellation conservatively around external effects", async () => {
    const clean = await createTestExecution("clean cancellation");
    const now = new Date("2026-08-22T12:00:00Z");
    await claimAttemptById(db(), clean.execution.attempt.id, "worker-a", 30_000, now);
    await requestJobCancellation(db(), clean.execution.job.id, 100, new Date(now.getTime() + 1));
    const cancelled = await settleAttempt(
      db(),
      clean.execution.attempt.id,
      "worker-a",
      { status: "failed", error: "aborted" },
      new Date(now.getTime() + 2),
    );
    expect(cancelled?.status).toBe("cancelled");

    const late = await createTestExecution("cancellation settled after abort grace");
    await claimAttemptById(db(), late.execution.attempt.id, "worker-a", 30_000, now);
    await requestJobCancellation(db(), late.execution.job.id, 100, new Date(now.getTime() + 1));
    const lateCancelled = await settleAttempt(
      db(),
      late.execution.attempt.id,
      "worker-a",
      { status: "failed", error: "aborted" },
      new Date(now.getTime() + 200),
    );
    expect(lateCancelled?.status).toBe("cancelled");
    expect(await getJob(db(), late.execution.job.id)).toMatchObject({ status: "cancelled" });

    const completed = await createTestExecution("completed during cancellation");
    await claimAttemptById(db(), completed.execution.attempt.id, "worker-c", 30_000, now);
    const completedLease = {
      attemptId: completed.execution.attempt.id,
      workerId: "worker-c",
      leaseDurationMs: 30_000,
    };
    await beginExternalAttemptEffect(db(), completedLease, "completed-call", new Date(now.getTime() + 1));
    await requestJobCancellation(db(), completed.execution.job.id, 100, new Date(now.getTime() + 2));
    expect(
      await completeExternalAttemptEffect(
        db(),
        completedLease,
        {
          type: "record_tool_result",
          callId: "completed-call",
          toolId: "send_email",
          riskClass: "destructive",
          arguments: { to: "a@example.com" },
          result: { status: "sent" },
          status: "executed",
          gated: false,
          externalEffectCompleted: true,
        },
        new Date(now.getTime() + 3),
      ),
    ).toBeDefined();
    const completedCancellation = await settleAttempt(
      db(),
      completed.execution.attempt.id,
      "worker-c",
      { status: "failed", error: "aborted after provider response" },
      new Date(now.getTime() + 4),
    );
    expect(completedCancellation?.status).toBe("cancelled");

    const uncertain = await createTestExecution("uncertain cancellation");
    await claimAttemptById(db(), uncertain.execution.attempt.id, "worker-b", 30_000, now);
    expect(
      await beginExternalAttemptEffect(
        db(),
        { attemptId: uncertain.execution.attempt.id, workerId: "worker-b", leaseDurationMs: 30_000 },
        "provider-call",
        new Date(now.getTime() + 1),
      ),
    ).toBe(true);
    await requestJobCancellation(db(), uncertain.execution.job.id, 100, new Date(now.getTime() + 2));
    const unknown = await settleAttempt(
      db(),
      uncertain.execution.attempt.id,
      "worker-b",
      { status: "failed", error: "aborted" },
      new Date(now.getTime() + 3),
    );
    expect(unknown?.status).toBe("outcome_unknown");
    expect(unknown?.job.status).toBe("outcome_unknown");
  });

  it("does not clear an external-effect marker after the lease boundary", async () => {
    const { execution } = await createTestExecution("late provider completion");
    const now = new Date("2026-08-22T12:00:00Z");
    await claimAttemptById(db(), execution.attempt.id, "worker-a", 100, now);
    const lease = { attemptId: execution.attempt.id, workerId: "worker-a", leaseDurationMs: 100 };
    await beginExternalAttemptEffect(db(), lease, "late-call", new Date(now.getTime() + 1));

    const applied = await completeExternalAttemptEffect(
      db(),
      lease,
      {
        type: "record_tool_result",
        callId: "late-call",
        toolId: "send_email",
        riskClass: "destructive",
        arguments: { to: "a@example.com" },
        result: { status: "sent" },
        status: "executed",
        gated: false,
        externalEffectCompleted: true,
      },
      new Date(now.getTime() + 99),
      new Date(now.getTime() + 100),
    );

    expect(applied).toBeUndefined();
    expect(await getJobAttempt(db(), execution.attempt.id)).toMatchObject({ externalEffectCallId: "late-call" });
  });
});

describe("retry input and tool_calls.jobAttemptId", () => {
  it("accepts a retry-typed attempt input and a tool_calls row scoped to an attempt", async () => {
    const persona = await createPersona(db(), {
      name: "Retry Fixture",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const queued = await createQueuedJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "user",
      prompt: "hi",
      langgraphThreadId: randomUUID(),
    });

    // Settle the first attempt so we can insert a second one
    const now = new Date("2026-08-30T12:00:00.000Z");
    await claimAttemptById(db(), queued.attempt.id, "worker-a", 30_000, now);
    await settleAttempt(db(), queued.attempt.id, "worker-a", { status: "done" }, new Date(now.getTime() + 1));

    const [retryAttempt] = await db()
      .insert(jobAttempts)
      .values({ jobId: queued.job.id, sequence: 2, input: { type: "retry" } })
      .returning();
    expect(retryAttempt.input).toEqual({ type: "retry" });

    const [call] = await db()
      .insert(toolCalls)
      .values({
        jobId: queued.job.id,
        jobAttemptId: queued.attempt.id,
        toolId: "get_weather",
        riskClass: "read_only",
        arguments: {},
      })
      .returning();
    expect(call.jobAttemptId).toBe(queued.attempt.id);

    const [reloaded] = await db().select().from(toolCalls).where(eq(toolCalls.id, call.id));
    expect(reloaded.jobAttemptId).toBe(queued.attempt.id);
  });
});

function fakeAttempt(overrides: Partial<JobAttemptRow> = {}): JobAttemptRow {
  return {
    id: "attempt-1",
    jobId: "job-1",
    sequence: 1,
    input: { type: "user_message", content: "hi" },
    notifyOnOutcome: false,
    status: "failed",
    workerId: "w",
    leaseExpiresAt: new Date(),
    deadlineAt: new Date(),
    lastHeartbeatAt: new Date(),
    startedAt: new Date(),
    finishedAt: new Date(),
    cancelRequestedAt: null,
    cancelReason: null,
    abortAfter: null,
    externalEffectCallId: null,
    externalEffectStartedAt: null,
    error: "boom",
    createdAt: new Date(),
    ...overrides,
  };
}

function fakeToolCall(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    id: "tc-1",
    jobId: "job-1",
    jobAttemptId: "attempt-1",
    callId: null,
    toolId: "send_email",
    riskClass: "reversible",
    arguments: {},
    status: "executed",
    result: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("evaluateRetryEligibility", () => {
  it("refuses when the job is done", () => {
    const result = evaluateRetryEligibility({ status: "done" } as Pick<JobRow, "status">, fakeAttempt(), []);
    expect(result).toEqual({ eligible: false, reason: expect.stringContaining("nothing to retry") });
  });

  it("refuses when the job is outcome_unknown", () => {
    const result = evaluateRetryEligibility({ status: "outcome_unknown" } as Pick<JobRow, "status">, fakeAttempt(), []);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/external action/);
  });

  it("refuses when the job is still active", () => {
    for (const status of ["queued", "running", "cancelling", "waiting_approval"] as const) {
      const result = evaluateRetryEligibility({ status } as Pick<JobRow, "status">, fakeAttempt(), []);
      expect(result.eligible).toBe(false);
    }
  });

  it("refuses when there is no prior attempt", () => {
    const result = evaluateRetryEligibility({ status: "failed" } as Pick<JobRow, "status">, undefined, []);
    expect(result.eligible).toBe(false);
  });

  it("refuses when the last attempt's external effect marker is still set", () => {
    const result = evaluateRetryEligibility(
      { status: "failed" } as Pick<JobRow, "status">,
      fakeAttempt({ externalEffectCallId: "call-1" }),
      [],
    );
    expect(result.eligible).toBe(false);
  });

  it("refuses when a destructive tool executed during the last attempt", () => {
    const result = evaluateRetryEligibility({ status: "failed" } as Pick<JobRow, "status">, fakeAttempt(), [
      fakeToolCall({ riskClass: "destructive", status: "executed" }),
    ]);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/tool already ran/);
  });

  it("refuses when a reversible tool failed mid-execution during the last attempt", () => {
    const result = evaluateRetryEligibility({ status: "failed" } as Pick<JobRow, "status">, fakeAttempt(), [
      fakeToolCall({ riskClass: "reversible", status: "failed" }),
    ]);
    expect(result.eligible).toBe(false);
  });

  it("allows when a destructive tool was only proposed, never run", () => {
    const result = evaluateRetryEligibility({ status: "failed" } as Pick<JobRow, "status">, fakeAttempt(), [
      fakeToolCall({ riskClass: "destructive", status: "pending_approval" }),
    ]);
    expect(result.eligible).toBe(true);
  });

  it("allows when only a read-only tool executed", () => {
    const result = evaluateRetryEligibility({ status: "failed" } as Pick<JobRow, "status">, fakeAttempt(), [
      fakeToolCall({ riskClass: "read_only", status: "executed" }),
    ]);
    expect(result.eligible).toBe(true);
  });

  it("allows a clean failed attempt with no tool calls", () => {
    const result = evaluateRetryEligibility({ status: "failed" } as Pick<JobRow, "status">, fakeAttempt(), []);
    expect(result).toEqual({ eligible: true });
  });

  it("allows cancelled and timed_out the same way", () => {
    for (const status of ["cancelled", "timed_out"] as const) {
      const result = evaluateRetryEligibility({ status } as Pick<JobRow, "status">, fakeAttempt({ status }), []);
      expect(result.eligible).toBe(true);
    }
  });
});

describe("enqueueRetry", () => {
  async function failedExecution(prompt: string) {
    const persona = await createPersona(db(), {
      name: `Retry ${prompt}`,
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const queued = await createQueuedJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "user",
      prompt,
      langgraphThreadId: randomUUID(),
    });
    // claimAttemptById(db, attemptId, workerId, leaseDurationMs, injectedNow?, executionTimeoutMs) —
    // injectedNow sits before executionTimeoutMs; pass undefined to use the real clock.
    const claimed = await claimAttemptById(db(), queued.attempt.id, "worker-1", 30_000, undefined, 300_000);
    if (!claimed) throw new Error("failed to claim in test setup");
    const settled = await settleAttempt(db(), claimed.attempt.id, "worker-1", {
      status: "failed",
      error: "boom",
    });
    if (!settled) throw new Error("failed to settle in test setup");
    return queued;
  }

  async function twoFailedExecutionsWithUnattributedEffect() {
    const unaffected = await failedExecution("unaffected by another job");
    const affected = await failedExecution("owns an unattributed effect");
    await createToolCall(db(), {
      jobId: affected.job.id,
      toolId: "send_email",
      riskClass: "destructive",
      status: "executed",
      arguments: {},
      result: {},
    });
    return { unaffected, affected };
  }

  it("enqueues a retry-typed attempt without inserting a new message", async () => {
    const queued = await failedExecution("retry me");
    const retried = await enqueueRetry(db(), queued.job.id);
    expect(retried?.attempt.input).toEqual({ type: "retry" });
    expect(retried?.job.status).toBe("queued");
    expect(retried?.attempt.sequence).toBe(2);

    const rows = await db().select().from(messages).where(eq(messages.jobId, queued.job.id));
    expect(rows).toHaveLength(1); // only the original prompt — no duplicate
  });

  it("refuses when a destructive tool already executed in the last attempt", async () => {
    const queued = await failedExecution("dangerous");
    await createToolCall(db(), {
      jobId: queued.job.id,
      jobAttemptId: queued.attempt.id,
      toolId: "send_email",
      riskClass: "destructive",
      status: "executed",
      arguments: {},
      result: {},
    });
    const retried = await enqueueRetry(db(), queued.job.id);
    expect(retried).toBeUndefined();
  });

  it("keeps an unattributed effect scoped to its own job in retry eligibility", async () => {
    const { unaffected, affected } = await twoFailedExecutionsWithUnattributedEffect();

    expect(await getRetryEligibility(db(), unaffected.job.id)).toEqual({ eligible: true });
    expect(await getRetryEligibility(db(), affected.job.id)).toEqual({
      eligible: false,
      reason: expect.stringContaining("already ran"),
    });
  });

  it("keeps an unattributed effect scoped to its own job when enqueueing retries", async () => {
    const { unaffected, affected } = await twoFailedExecutionsWithUnattributedEffect();

    expect(await enqueueRetry(db(), unaffected.job.id)).toMatchObject({ attempt: { input: { type: "retry" } } });
    expect(await enqueueRetry(db(), affected.job.id)).toBeUndefined();
  });

  it("refuses when a gated destructive tool executed in a LATER attempt than the one that proposed it", async () => {
    // This is the exact gap the final review found: create_pending_tool_call
    // stamps jobAttemptId with the *proposing* attempt, but a gated call only
    // executes after enqueueApprovalResume creates a new, later attempt. If
    // that later attempt's execution doesn't restamp jobAttemptId onto itself,
    // eligibility queries scoped to "the last attempt" never see it.
    const persona = await createPersona(db(), {
      name: "Gated Retry",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const queued = await createQueuedJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "user",
      prompt: "send an email",
      langgraphThreadId: randomUUID(),
    });

    // Attempt 1 proposes the destructive call and pauses for approval.
    const proposing = await claimAttemptById(db(), queued.attempt.id, "worker-a", 30_000);
    if (!proposing) throw new Error("failed to claim proposing attempt in test setup");
    const paused = await settleAttempt(db(), proposing.attempt.id, "worker-a", {
      status: "waiting_approval",
      effects: [
        {
          type: "create_pending_tool_call",
          callId: "gated-call",
          toolId: "send_email",
          riskClass: "destructive",
          arguments: { to: "a@example.com" },
        },
      ],
    });
    const pendingCall = paused?.applied.toolCalls[0];
    if (!pendingCall) throw new Error("expected a pending tool call in test setup");
    expect(pendingCall.jobAttemptId).toBe(proposing.attempt.id);

    // Approving creates attempt 2 (approval_resume) and marks the call approved.
    const resumed = await enqueueApprovalResume(db(), pendingCall.id, true);
    if (!resumed) throw new Error("failed to enqueue approval resume in test setup");
    expect(resumed.attempt.sequence).toBe(2);

    // Attempt 2 actually executes the tool.
    const executing = await claimAttemptById(db(), resumed.attempt.id, "worker-b", 30_000);
    if (!executing) throw new Error("failed to claim executing attempt in test setup");
    const applied = await applyAttemptEffects(
      db(),
      { attemptId: executing.attempt.id, workerId: "worker-b", leaseDurationMs: 30_000 },
      [
        {
          type: "record_tool_result",
          callId: "gated-call",
          toolId: "send_email",
          riskClass: "destructive",
          arguments: { to: "a@example.com" },
          result: { status: "sent" },
          status: "executed",
          gated: true,
        },
      ],
    );
    const executedCall = applied?.toolCalls[0];
    expect(executedCall).toMatchObject({ status: "executed", riskClass: "destructive" });
    // The fix under test: the row is restamped onto the attempt that actually ran it.
    expect(executedCall?.jobAttemptId).toBe(executing.attempt.id);

    // Attempt 2 then fails for an unrelated reason.
    const settled = await settleAttempt(db(), executing.attempt.id, "worker-b", {
      status: "failed",
      error: "unrelated failure after the tool ran",
    });
    expect(settled?.job.status).toBe("failed");

    expect(await enqueueRetry(db(), queued.job.id)).toBeUndefined();
    expect(await getRetryEligibility(db(), queued.job.id)).toEqual({
      eligible: false,
      reason: expect.stringContaining("already ran"),
    });
  });

  it("refuses when the job is done", async () => {
    const persona = await createPersona(db(), {
      name: "Done Job",
      role: "R",
      systemPrompt: "S",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const queued = await createQueuedJob(db(), {
      personaId: persona.id,
      depth: 0,
      origin: "user",
      prompt: "done",
      langgraphThreadId: randomUUID(),
    });
    const claimed = await claimAttemptById(db(), queued.attempt.id, "worker-1", 30_000, undefined, 300_000);
    if (!claimed) throw new Error("failed to claim in test setup");
    await settleAttempt(db(), claimed.attempt.id, "worker-1", { status: "done" });
    const retried = await enqueueRetry(db(), queued.job.id);
    expect(retried).toBeUndefined();
  });
});
