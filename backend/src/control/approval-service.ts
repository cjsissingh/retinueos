import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { toolCalls, type ToolCallRow } from "../db/schema.js";
import { enqueueApprovalResume } from "../jobs/job-attempt-repo.js";
import { getJob } from "../jobs/job-repo.js";
import { getToolCall } from "../tool-calls/tool-call-repo.js";
import {
  claimControlOperation,
  completeControlOperation,
  createControlAuditEvent,
  getControlOperation,
  type OperationClaim,
} from "./control-repo.js";
import { ControlError, type ControlActor, type PageRequest, type PageResult } from "./types.js";
import { broadcastPendingApprovals } from "../orchestration/pending-approval-bus.js";
import { markNotificationActedByToolCallId } from "../notifications/notification-repo.js";
import { broadcastNotifications } from "../orchestration/notification-bus.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface Cursor {
  createdAt: string;
  id: string;
}

function requireScope(actor: ControlActor, scope: "approvals:read" | "approvals:write"): void {
  if (actor.kind === "mcp_client" && !actor.scopes.includes(scope)) {
    throw new ControlError("insufficient_scope", `missing required scope: ${scope}`);
  }
}

function pageSize(limit: number | undefined): number {
  return limit === undefined ? DEFAULT_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function decodeCursor(value: string): Cursor {
  try {
    // SAFETY: the cursor object is validated field-by-field before use.
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ControlError("invalid_input", "invalid pending approval cursor");
  }
}

function encodeCursor(row: ToolCallRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}

function actionFor(decision: "approve" | "reject"): "approval.approve" | "approval.reject" {
  return decision === "approve" ? "approval.approve" : "approval.reject";
}

export interface ApprovalServiceDependencies {
  /** Test seam for a failure while persisting approval audit attribution. */
  writeAuditEvent?: typeof createControlAuditEvent;
  /** Test seam for a failure after the in-transaction idempotency claim. */
  afterClaim?: () => Promise<void>;
}

/** The durable approval boundary shared by REST and future MCP adapters. */
export class ApprovalService {
  constructor(
    private db: DrizzleDb,
    private dependencies: ApprovalServiceDependencies = {},
  ) {}

  async listPending(actor: ControlActor, page: PageRequest = {}): Promise<PageResult<ToolCallRow>> {
    requireScope(actor, "approvals:read");
    const conditions = [eq(toolCalls.status, "pending_approval")];
    if (page.cursor) {
      const cursor = decodeCursor(page.cursor);
      const createdAt = new Date(cursor.createdAt);
      const afterCursor = or(
        lt(toolCalls.createdAt, createdAt),
        and(eq(toolCalls.createdAt, createdAt), lt(toolCalls.id, cursor.id)),
      );
      if (afterCursor) conditions.push(afterCursor);
    }
    const limit = pageSize(page.limit);
    const rows = await this.db
      .select()
      .from(toolCalls)
      .where(and(...conditions))
      .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit && items.length ? encodeCursor(items.at(-1)!) : null };
  }

  async resolve(
    actor: ControlActor,
    toolCallId: string,
    decision: "approve" | "reject",
    idempotencyKey: string,
  ): Promise<ToolCallRow> {
    requireScope(actor, "approvals:write");
    const before = await getToolCall(this.db, toolCallId);
    if (!before) throw new ControlError("not_found", "tool call not found");

    const action = actionFor(decision);
    try {
      let claim: Extract<OperationClaim, { kind: "claimed" }> | undefined;
      const queued = await enqueueApprovalResume(
        this.db,
        toolCallId,
        decision === "approve",
        async (tx, execution) => {
          const completedClaim = this.requireClaim(claim);
          await (this.dependencies.writeAuditEvent ?? createControlAuditEvent)(tx, {
            actor,
            action,
            targetType: "tool_call",
            targetId: execution.toolCall.id,
            idempotencyKey,
            before: { toolCall: before },
            after: { toolCall: execution.toolCall },
            outcome: "succeeded",
          });
          await completeControlOperation(
            tx,
            completedClaim.operation.id,
            { toolCallId: execution.toolCall.id, status: execution.toolCall.status },
            "tool_call",
            execution.toolCall.id,
          );
        },
        async (tx) => {
          const operation = await claimControlOperation(tx, actor, action, idempotencyKey, { toolCallId, decision });
          if (operation.kind !== "claimed") {
            throw new ControlError("conflict", "approval idempotency operation was already resolved");
          }
          claim = operation;
          await this.dependencies.afterClaim?.();
        },
      );
      if (!queued) return await this.replayOrConflict(actor, action, idempotencyKey, toolCallId, decision);
      // The pending row is already gone here — the worker hasn't picked up
      // the resume yet. Broadcast now so other tabs drop the card without
      // waiting for settlement.
      await broadcastPendingApprovals(this.db);
      await markNotificationActedByToolCallId(this.db, toolCallId);
      await broadcastNotifications(this.db);
      return queued.toolCall;
    } catch (error) {
      const controlError =
        error instanceof ControlError ? error : new ControlError("internal", "approval resolution failed", true);
      throw controlError;
    }
  }

  private requireClaim(
    claim: Extract<OperationClaim, { kind: "claimed" }> | undefined,
  ): Extract<OperationClaim, { kind: "claimed" }> {
    if (!claim) throw new ControlError("internal", "approval transaction is missing its idempotency claim", true);
    return claim;
  }

  private async replayOrConflict(
    actor: ControlActor,
    action: "approval.approve" | "approval.reject",
    idempotencyKey: string,
    toolCallId: string,
    decision: "approve" | "reject",
  ): Promise<ToolCallRow> {
    const operation = await getControlOperation(this.db, actor, action, idempotencyKey, { toolCallId, decision });
    if (operation?.kind === "completed") {
      const replayed = await getToolCall(this.db, toolCallId);
      if (!replayed) throw new ControlError("internal", "completed approval operation is missing its tool call", true);
      return replayed;
    }
    if (operation?.kind === "reconciliation_pending") {
      throw new ControlError("internal", "approval resolution cannot require scheduler reconciliation", true);
    }
    throw await this.resumeConflict(toolCallId);
  }

  private async resumeConflict(toolCallId: string): Promise<ControlError> {
    const [current, job] = await Promise.all([
      getToolCall(this.db, toolCallId),
      getToolCall(this.db, toolCallId).then((toolCall) => (toolCall ? getJob(this.db, toolCall.jobId) : undefined)),
    ]);
    const reason =
      current?.status !== "pending_approval"
        ? `tool call already ${current?.status ?? "resolved"}`
        : `job cannot resume while ${job?.status ?? "missing"}`;
    return new ControlError("conflict", reason);
  }
}
