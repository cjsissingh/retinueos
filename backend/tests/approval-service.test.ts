import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import { ApprovalService } from "../src/control/approval-service.js";
import { ControlAuditService } from "../src/control/audit-service.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob, getJob, transitionJobStatus } from "../src/jobs/job-repo.js";
import { createToolCall, getToolCall } from "../src/tool-calls/tool-call-repo.js";
import { controlAuditEvents, controlOperations } from "../src/db/schema.js";
import { and, eq } from "drizzle-orm";
import { defaultPendingApprovalBus } from "../src/orchestration/pending-approval-bus.js";
import type { NotificationRow } from "../src/db/schema.js";
import { insertNotification, listNotificationsPage } from "../src/notifications/notification-repo.js";
import { defaultNotificationBus } from "../src/orchestration/notification-bus.js";

const { db } = useTestDb();

const owner = { kind: "owner", source: "rest" } as const;
const readClient = { kind: "mcp_client", clientId: "approval-reader", scopes: ["approvals:read"] } as const;
const writeClient = { kind: "mcp_client", clientId: "approval-writer", scopes: ["approvals:write"] } as const;
const auditClient = { kind: "mcp_client", clientId: "auditor", scopes: ["audit:read"] } as const;

async function pendingToolCall() {
  const persona = await createPersona(db(), {
    name: "Approver",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user", prompt: "approve this" });
  await transitionJobStatus(db(), job.id, "queued", "waiting_approval");
  return createToolCall(db(), { jobId: job.id, toolId: "send_email", riskClass: "destructive", arguments: {} });
}

describe("ApprovalService", () => {
  it("enforces approval read and write scopes independently", async () => {
    const toolCall = await pendingToolCall();
    const service = new ApprovalService(db());

    await expect(service.listPending(writeClient, { limit: 50 })).rejects.toMatchObject({
      category: "insufficient_scope",
    });
    await expect(service.resolve(readClient, toolCall.id, "approve", "approval-key")).rejects.toMatchObject({
      category: "insufficient_scope",
    });
    expect(await service.listPending(readClient, { limit: 50 })).toMatchObject({ items: [toolCall] });
  });

  it("resolves an approval through the existing resume lifecycle and audits the trusted client", async () => {
    const toolCall = await pendingToolCall();
    const notification = await insertNotification(db(), {
      kind: "approval_needed",
      title: "Approval needed",
      message: "needs you",
      toolCallId: toolCall.id,
    });
    const snapshots: NotificationRow[][] = [];
    const unsubscribe = defaultNotificationBus.subscribe((items) => snapshots.push(items));
    const approvalService = new ApprovalService(db());
    const auditService = new ControlAuditService(db());

    await approvalService.resolve(writeClient, toolCall.id, "approve", "approval-key");
    unsubscribe();

    expect(await getToolCall(db(), toolCall.id)).toMatchObject({ status: "approved" });
    expect(
      (await listNotificationsPage(db(), {})).items.find((item) => item.id === notification.id)?.actedAt,
    ).not.toBeNull();
    expect(snapshots.at(-1)?.find((item) => item.id === notification.id)?.actedAt).not.toBeNull();
    expect((await auditService.list(auditClient, { limit: 50 })).items[0]).toMatchObject({
      actorKind: "mcp_client",
      actorId: "approval-writer",
      action: "approval.approve",
      targetType: "tool_call",
      targetId: toolCall.id,
      outcome: "succeeded",
    });
  });

  it("attributes rejected approvals to the resolving actor", async () => {
    const toolCall = await pendingToolCall();
    const approvalService = new ApprovalService(db());
    const auditService = new ControlAuditService(db());

    await approvalService.resolve(owner, toolCall.id, "reject", "reject-key");

    expect(await getToolCall(db(), toolCall.id)).toMatchObject({ status: "rejected" });
    expect((await auditService.list(owner, { action: "approval.reject", limit: 50 })).items).toEqual([
      expect.objectContaining({ actorKind: "owner", actorId: "rest", targetId: toolCall.id }),
    ]);
  });

  it("returns the completed approval result to concurrent callers using the same idempotency key", async () => {
    const toolCall = await pendingToolCall();
    const service = new ApprovalService(db());

    const [first, replay] = await Promise.all([
      service.resolve(owner, toolCall.id, "approve", "same-approval-key"),
      service.resolve(owner, toolCall.id, "approve", "same-approval-key"),
    ]);

    expect(first).toMatchObject({ id: toolCall.id, status: "approved" });
    expect(replay).toMatchObject({ id: toolCall.id, status: "approved" });
    expect(
      await db().select().from(controlOperations).where(eq(controlOperations.idempotencyKey, "same-approval-key")),
    ).toMatchObject([{ status: "completed", targetId: toolCall.id }]);
  });

  it("reports a conflict when a pending approval can no longer resume its job", async () => {
    const toolCall = await pendingToolCall();
    const service = new ApprovalService(db());
    await transitionJobStatus(db(), toolCall.jobId, "waiting_approval", "failed", "lost resume ownership");

    await expect(service.resolve(owner, toolCall.id, "approve", "stale-key")).rejects.toMatchObject({
      category: "conflict",
    });
    expect(await getToolCall(db(), toolCall.id)).toMatchObject({ status: "pending_approval" });
  });

  it("rolls back the approval resume and idempotency claim when its audit settlement fails", async () => {
    const toolCall = await pendingToolCall();
    const service = new ApprovalService(db(), {
      writeAuditEvent: async () => {
        throw new Error("simulated audit write failure");
      },
    });

    await expect(service.resolve(owner, toolCall.id, "approve", "failed-settlement-key")).rejects.toMatchObject({
      category: "internal",
    });

    expect(await getToolCall(db(), toolCall.id)).toMatchObject({ status: "pending_approval" });
    expect(await getJob(db(), toolCall.jobId)).toMatchObject({ status: "waiting_approval" });
    expect(
      await db()
        .select()
        .from(controlAuditEvents)
        .where(and(eq(controlAuditEvents.targetId, toolCall.id), eq(controlAuditEvents.action, "approval.approve"))),
    ).toEqual([]);
    expect(
      await db().select().from(controlOperations).where(eq(controlOperations.idempotencyKey, "failed-settlement-key")),
    ).toEqual([]);

    await expect(
      new ApprovalService(db()).resolve(owner, toolCall.id, "approve", "failed-settlement-key"),
    ).resolves.toMatchObject({
      status: "approved",
    });
  });

  it("does not strand an idempotency claim when approval setup aborts before mutation", async () => {
    const toolCall = await pendingToolCall();
    const service = new ApprovalService(db(), {
      afterClaim: async () => {
        throw new Error("simulated crash after idempotency claim");
      },
    });

    await expect(service.resolve(owner, toolCall.id, "approve", "claimed-then-abort-key")).rejects.toMatchObject({
      category: "internal",
    });

    expect(await getToolCall(db(), toolCall.id)).toMatchObject({ status: "pending_approval" });
    expect(await getJob(db(), toolCall.jobId)).toMatchObject({ status: "waiting_approval" });
    expect(
      await db().select().from(controlOperations).where(eq(controlOperations.idempotencyKey, "claimed-then-abort-key")),
    ).toEqual([]);
    await expect(
      new ApprovalService(db()).resolve(owner, toolCall.id, "approve", "claimed-then-abort-key"),
    ).resolves.toMatchObject({
      status: "approved",
    });
  });

  it("broadcasts the remaining pending snapshot after a successful resolve", async () => {
    const toolCall = await pendingToolCall();
    const received: string[][] = [];
    const unsubscribe = defaultPendingApprovalBus.subscribe((items) => {
      received.push(items.map((item) => item.id));
    });
    try {
      await new ApprovalService(db()).resolve(owner, toolCall.id, "reject", "broadcast-key");
      expect(received.at(-1)).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
