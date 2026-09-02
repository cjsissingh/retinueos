import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "./setup/db.js";
import { PersonaQueryService } from "../src/control/persona-query-service.js";
import { JobService } from "../src/control/job-service.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { claimAttemptById, getQueuedAttemptForJob } from "../src/jobs/job-attempt-repo.js";
import { createMessage } from "../src/jobs/message-repo.js";
import { createToolCall } from "../src/tool-calls/tool-call-repo.js";
import { controlAuditEvents, jobs as jobsTable } from "../src/db/schema.js";
import { defaultPendingApprovalBus } from "../src/orchestration/pending-approval-bus.js";
import { listMessagesByJob } from "../src/jobs/message-repo.js";

const { db } = useTestDb();

const owner = { kind: "owner", source: "rest" } as const;
const personaReadClient = { kind: "mcp_client", clientId: "persona-reader", scopes: ["personas:read"] } as const;
const jobReadClient = { kind: "mcp_client", clientId: "job-reader", scopes: ["jobs:read"] } as const;
const jobWriteClient = { kind: "mcp_client", clientId: "job-writer", scopes: ["jobs:write"] } as const;
const readOnlyClient = { kind: "mcp_client", clientId: "reader", scopes: ["jobs:read"] } as const;

async function hire(name = "A", provider = "anthropic") {
  return createPersona(db(), {
    name,
    role: "R",
    systemPrompt: "S",
    modelProvider: provider,
    modelName: "m",
    assignedToolIds: [],
  });
}

function services(
  options: {
    providers?: string[];
    abortAttempt?: (attemptId: string) => void;
    publishStatus?: (id: string, status: string) => void;
  } = {},
) {
  return {
    personas: new PersonaQueryService(db()),
    jobs: new JobService(
      db(),
      { availableProviders: options.providers ?? ["anthropic"] },
      { abortAttempt: options.abortAttempt, publishStatus: options.publishStatus },
    ),
  };
}

describe("PersonaQueryService", () => {
  it("requires personas:read for MCP clients while the REST owner remains compatible", async () => {
    const persona = await hire();
    const service = services().personas;

    await expect(service.listAll(jobReadClient)).rejects.toMatchObject({ category: "insufficient_scope" });
    expect(await service.listAll(owner)).toEqual(expect.arrayContaining([persona]));
    expect(await service.listPage(personaReadClient, { limit: 50 })).toMatchObject({ items: [persona] });
  });

  it("paginates personas with capped stable cursors and rejects malformed cursors", async () => {
    const service = services().personas;
    await Promise.all(Array.from({ length: 101 }, (_, index) => hire(`Persona ${index}`)));

    const capped = await service.listPage(personaReadClient, { limit: 500 });
    const first = await service.listPage(personaReadClient, { limit: 2 });
    const second = await service.listPage(personaReadClient, { limit: 2, cursor: first.nextCursor! });
    expect(capped.items).toHaveLength(100);
    expect(first.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((persona) => persona.id)).size).toBe(4);
    await expect(service.listPage(personaReadClient, { cursor: "not-a-cursor" })).rejects.toMatchObject({
      category: "invalid_input",
    });
  });
});

describe("JobService", () => {
  it("enforces job read and write scopes independently", async () => {
    const persona = await hire();
    const { jobs } = services();

    await expect(
      jobs.create(readOnlyClient, { personaId: persona.id, prompt: "hello" }, "job-key"),
    ).rejects.toMatchObject({
      category: "insufficient_scope",
    });
    await expect(jobs.listAll(jobWriteClient)).rejects.toMatchObject({ category: "insufficient_scope" });
    await expect(jobs.get(jobWriteClient, persona.id)).rejects.toMatchObject({ category: "insufficient_scope" });
  });

  it("creates a durable job once, writes an audit event, and preserves owner access", async () => {
    const persona = await hire();
    const { jobs } = services();

    const first = await jobs.create(owner, { personaId: persona.id, prompt: "hello" }, "job-key");
    const replay = await jobs.create(owner, { personaId: persona.id, prompt: "hello" }, "job-key");
    const [audit] = await db().select().from(controlAuditEvents).where(eq(controlAuditEvents.targetId, first.id));

    expect(replay).toEqual(first);
    expect(await jobs.get(owner, first.id)).toEqual(first);
    expect(audit).toMatchObject({ action: "job.create", outcome: "succeeded", targetType: "job", targetId: first.id });
  });

  it("fails provider readiness before queueing a job", async () => {
    const persona = await hire("OpenAI", "openai");
    const { jobs } = services({ providers: ["anthropic"] });

    await expect(jobs.create(owner, { personaId: persona.id, prompt: "hello" }, "job-key")).rejects.toMatchObject({
      category: "conflict",
      message: expect.stringContaining("OPENAI_API_KEY"),
    });
  });

  it("paginates job details messages and returns only pending approvals", async () => {
    const persona = await hire();
    const { jobs } = services();
    const job = await jobs.create(owner, { personaId: persona.id, prompt: "first" }, "job-key");
    await createMessage(db(), job.id, "assistant", "second");
    await createToolCall(db(), { jobId: job.id, toolId: "safe", riskClass: "safe", arguments: {} });
    await createToolCall(db(), {
      jobId: job.id,
      toolId: "done",
      riskClass: "safe",
      arguments: {},
      status: "executed",
      result: {},
    });

    const details = await jobs.getDetails(jobReadClient, job.id, { limit: 1 });
    expect(details).toMatchObject({
      job,
      messages: { items: [{ content: "second" }], nextCursor: expect.any(String) },
    });
    expect(details.pendingApprovals).toHaveLength(1);
  });

  it("limits persona actors to their own jobs across list, page, get, and details", async () => {
    const ownPersona = await hire("Own");
    const foreignPersona = await hire("Foreign");
    const { jobs } = services();
    const ownJob = await jobs.create(owner, { personaId: ownPersona.id, prompt: "own" }, "own-job");
    const foreignParent = await jobs.create(
      owner,
      { personaId: foreignPersona.id, prompt: "foreign parent" },
      "foreign-parent",
    );
    const foreignChild = await createJob(db(), {
      personaId: foreignPersona.id,
      parentJobId: foreignParent.id,
      depth: 1,
      origin: "delegation",
      prompt: "foreign child",
    });
    const personaActor = {
      kind: "persona",
      personaId: ownPersona.id,
      jobId: ownJob.id,
      toolCallId: "tool-call-1",
    } as const;

    expect(await jobs.listAll(personaActor)).toEqual([ownJob]);
    expect(await jobs.listPage(personaActor, { limit: 50 })).toMatchObject({ items: [ownJob] });
    await expect(jobs.listAll(personaActor, { parentJobId: foreignParent.id })).resolves.toEqual([]);
    expect(await jobs.listPage(personaActor, { limit: 50 }, { parentJobId: foreignParent.id })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await jobs.get(personaActor, ownJob.id)).toEqual(ownJob);
    await expect(jobs.get(personaActor, foreignChild.id)).rejects.toMatchObject({ category: "ownership_violation" });
    expect(await jobs.getDetails(personaActor, ownJob.id, { limit: 50 })).toMatchObject({ job: ownJob });
    await expect(jobs.getDetails(personaActor, foreignChild.id, { limit: 50 })).rejects.toMatchObject({
      category: "ownership_violation",
    });
  });

  it("rejects continuation state conflicts and audits an accepted cancellation before callbacks", async () => {
    const abortAttempt = vi.fn();
    const publishStatus = vi.fn();
    const persona = await hire();
    const { jobs } = services({ abortAttempt, publishStatus });
    const job = await jobs.create(owner, { personaId: persona.id, prompt: "hello" }, "job-key");

    await expect(jobs.continue(owner, job.id, { prompt: "again" }, "continue-key")).rejects.toMatchObject({
      category: "conflict",
    });
    const attempt = await getQueuedAttemptForJob(db(), job.id);
    await claimAttemptById(db(), attempt!.id, "worker-a");
    const cancelled = await jobs.cancel(owner, job.id, "cancel-key");
    const [audit] = await db().select().from(controlAuditEvents).where(eq(controlAuditEvents.targetId, job.id));

    expect(cancelled).toMatchObject({ status: "cancelling" });
    expect(abortAttempt).toHaveBeenCalledWith(attempt!.id);
    expect(publishStatus).toHaveBeenCalledWith(job.id, "cancelling");
    expect(audit).toMatchObject({ action: "job.create" });
    expect(
      (await db().select().from(controlAuditEvents).where(eq(controlAuditEvents.action, "job.cancel")))[0],
    ).toMatchObject({
      outcome: "succeeded",
    });
  });

  it("replays a completed continue instead of duplicating the turn when the job is already working", async () => {
    const persona = await hire();
    const { jobs: jobService } = services();
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user", prompt: "hello" });
    await db().update(jobsTable).set({ status: "done" }).where(eq(jobsTable.id, job.id));

    const first = await jobService.continue(owner, job.id, { prompt: "again" }, "continue-retry-key");
    const second = await jobService.continue(owner, job.id, { prompt: "again" }, "continue-retry-key");
    const transcript = await listMessagesByJob(db(), job.id);

    expect(first.status).toBe("queued");
    expect(second).toMatchObject({ id: first.id, status: "queued" });
    expect(transcript.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["user", "again"],
    ]);
  });

  it("broadcasts the pending-approval snapshot after a successful cancel", async () => {
    const persona = await hire();
    const { jobs } = services();
    const job = await jobs.create(owner, { personaId: persona.id, prompt: "hello" }, "cancel-broadcast-job");
    const received: number[] = [];
    const unsubscribe = defaultPendingApprovalBus.subscribe((items) => received.push(items.length));
    try {
      await jobs.cancel(owner, job.id, "cancel-broadcast-key");
      expect(received).toEqual([0]);
    } finally {
      unsubscribe();
    }
  });
});
