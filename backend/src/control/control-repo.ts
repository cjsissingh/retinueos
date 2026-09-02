import { createHash } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import {
  controlAuditEvents,
  controlOperations,
  type ControlAuditEventRow,
  type ControlOperationRow,
} from "../db/schema.js";
import { boundJson } from "./bounded-json.js";
import {
  ControlError,
  type ControlAction,
  type ControlActor,
  type ControlTargetType,
  type PageResult,
} from "./types.js";

const MAX_OPERATION_RESULT_BYTES = 64 * 1024;
const MAX_AUDIT_DETAIL_BYTES = 32 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type ControlQueryable = Pick<DrizzleDb, "insert" | "select" | "update">;

export type OperationClaim =
  | { kind: "claimed"; operation: ControlOperationRow }
  | { kind: "completed"; operation: ControlOperationRow; result: Record<string, unknown> }
  | { kind: "reconciliation_pending"; operation: ControlOperationRow; result: Record<string, unknown> };

export interface CreateControlAuditEventInput {
  actor: ControlActor;
  action: ControlAction;
  targetType?: ControlTargetType;
  targetId?: string;
  sourceJobId?: string;
  sourceToolCallId?: string;
  mcpRequestId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  outcome?: "pending" | "succeeded" | "failed";
  errorCategory?: string;
}

export interface ListControlAuditEventsInput {
  actor?: ControlActor;
  action?: ControlAction;
  targetType?: ControlTargetType;
  targetId?: string;
  outcome?: "pending" | "succeeded" | "failed";
  cursor?: string;
  limit?: number;
}

interface AuditCursor {
  createdAt: string;
  id: string;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- JSON canonicalization walks arbitrary JSON-compatible values. */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    // SAFETY: value is a non-null object; JSON serialization consults toJSON before enumerating keys.
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      // SAFETY: the runtime function check establishes JSON's standard serialization hook.
      return canonicalizeJson((value as { toJSON(): unknown }).toJSON());
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]),
    );
  }
  return value;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

function boundRecord(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  // SAFETY: boundJson limits the persisted jsonb envelope and this helper
  // receives an object result owned by the control plane.
  return boundJson(value, maxBytes) as Record<string, unknown>;
}

function argumentsHash(arguments_: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(arguments_)))
    .digest("hex");
}

function actorId(actor: ControlActor): string {
  switch (actor.kind) {
    case "owner":
      return actor.source;
    case "mcp_client":
      return actor.clientId;
    case "persona":
      return actor.personaId;
  }
}

export function actorKey(actor: ControlActor): string {
  switch (actor.kind) {
    case "owner":
      return `owner:${actor.source}`;
    case "mcp_client":
      return `mcp_client:${actor.clientId}`;
    case "persona":
      return `persona:${actor.personaId}:${actor.jobId}:${actor.toolCallId}`;
  }
}

function operationClaim(operation: ControlOperationRow, hash: string): OperationClaim {
  if (operation.argumentsHash !== hash) {
    throw new ControlError("idempotency_conflict", "idempotency key was reused with different arguments");
  }
  if (operation.status === "completed") {
    return { kind: "completed", operation, result: operation.result ?? {} };
  }
  if (operation.status === "in_progress" && operation.errorCategory === "scheduler_reconciliation_pending") {
    return { kind: "reconciliation_pending", operation, result: operation.result ?? {} };
  }
  if (operation.status === "failed") {
    throw new ControlError("conflict", "idempotency operation previously failed; use a new idempotency key");
  }
  throw new ControlError("idempotency_conflict", "idempotency operation is still in progress", true);
}

export async function getControlOperation(
  db: Pick<DrizzleDb, "select">,
  actor: ControlActor,
  action: ControlAction,
  idempotencyKey: string,
  arguments_: Record<string, unknown>,
): Promise<OperationClaim | undefined> {
  const key = actorKey(actor);
  const hash = argumentsHash(arguments_);
  const [operation] = await db
    .select()
    .from(controlOperations)
    .where(
      and(
        eq(controlOperations.actorKey, key),
        eq(controlOperations.action, action),
        eq(controlOperations.idempotencyKey, idempotencyKey),
      ),
    );
  return operation ? operationClaim(operation, hash) : undefined;
}

export async function claimControlOperation(
  db: ControlQueryable,
  actor: ControlActor,
  action: ControlAction,
  idempotencyKey: string,
  arguments_: Record<string, unknown>,
): Promise<OperationClaim> {
  const key = actorKey(actor);
  const hash = argumentsHash(arguments_);
  const [inserted] = await db
    .insert(controlOperations)
    .values({ actorKey: key, action, idempotencyKey, argumentsHash: hash })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { kind: "claimed", operation: inserted };
  const existing = await getControlOperation(db, actor, action, idempotencyKey, arguments_);
  if (!existing) throw new ControlError("internal", "idempotency operation was not found", true);
  return existing;
}

export async function markControlOperationReconciliationPending(
  db: DrizzleDb,
  operationId: string,
  result: Record<string, unknown>,
  targetType: ControlTargetType,
  targetId: string,
): Promise<ControlOperationRow | undefined> {
  const [operation] = await db
    .update(controlOperations)
    .set({
      // SAFETY: boundJson limits the persisted recovery envelope and this
      // service-owned helper receives an object result.
      result: boundRecord(result, MAX_OPERATION_RESULT_BYTES),
      targetType,
      targetId,
      errorCategory: "scheduler_reconciliation_pending",
      updatedAt: new Date(),
    })
    .where(and(eq(controlOperations.id, operationId), eq(controlOperations.status, "in_progress")))
    .returning();
  return operation;
}

export async function completeControlOperation(
  db: ControlQueryable,
  operationId: string,
  result: Record<string, unknown>,
  targetType?: ControlTargetType,
  targetId?: string,
): Promise<ControlOperationRow | undefined> {
  const [operation] = await db
    .update(controlOperations)
    .set({
      status: "completed",
      // SAFETY: boundJson limits the persisted result envelope and this
      // service-owned helper receives an object result.
      result: boundRecord(result, MAX_OPERATION_RESULT_BYTES),
      targetType,
      targetId,
      errorCategory: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(controlOperations.id, operationId), eq(controlOperations.status, "in_progress")))
    .returning();
  return operation;
}

export async function failControlOperation(
  db: DrizzleDb,
  operationId: string,
  error: ControlError["category"] | ControlError,
): Promise<ControlOperationRow | undefined> {
  const [operation] = await db
    .update(controlOperations)
    .set({
      status: "failed",
      errorCategory: typeof error === "string" ? error : error.category,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(controlOperations.id, operationId), eq(controlOperations.status, "in_progress")))
    .returning();
  return operation;
}

export async function createControlAuditEvent(
  db: ControlQueryable,
  input: CreateControlAuditEventInput,
): Promise<ControlAuditEventRow> {
  const [event] = await db
    .insert(controlAuditEvents)
    .values({
      actorKind: input.actor.kind,
      actorId: actorId(input.actor),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      sourceJobId: input.sourceJobId ?? (input.actor.kind === "persona" ? input.actor.jobId : undefined),
      sourceToolCallId: input.sourceToolCallId ?? (input.actor.kind === "persona" ? input.actor.toolCallId : undefined),
      mcpRequestId: input.mcpRequestId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      before: input.before === undefined ? undefined : boundRecord(input.before, MAX_AUDIT_DETAIL_BYTES),
      after: input.after === undefined ? undefined : boundRecord(input.after, MAX_AUDIT_DETAIL_BYTES),
      outcome: input.outcome ?? "pending",
      errorCategory: input.errorCategory,
    })
    .returning();
  return event;
}

export async function settleControlAuditEvent(
  db: DrizzleDb,
  eventId: string,
  outcome: "succeeded" | "failed",
  errorCategory?: string | null,
): Promise<ControlAuditEventRow | undefined> {
  const [event] = await db
    .update(controlAuditEvents)
    .set({ outcome, errorCategory: errorCategory ?? null, settledAt: new Date() })
    .where(eq(controlAuditEvents.id, eventId))
    .returning();
  return event;
}

export async function markControlAuditEventReconciliationPending(
  db: DrizzleDb,
  eventId: string,
): Promise<ControlAuditEventRow | undefined> {
  const [event] = await db
    .update(controlAuditEvents)
    .set({ outcome: "pending", errorCategory: "scheduler_reconciliation_pending", settledAt: null })
    .where(eq(controlAuditEvents.id, eventId))
    .returning();
  return event;
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function encodeCursor(event: ControlAuditEventRow): string {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt.toISOString(), id: event.id })).toString("base64url");
}

function decodeCursor(cursor: string): AuditCursor {
  try {
    // SAFETY: the cursor object is validated field-by-field before use.
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<AuditCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ControlError("invalid_input", "invalid audit cursor");
  }
}

export async function listControlAuditEvents(
  db: DrizzleDb,
  input: ListControlAuditEventsInput = {},
): Promise<PageResult<ControlAuditEventRow>> {
  const conditions = [];
  if (input.actor) {
    conditions.push(eq(controlAuditEvents.actorKind, input.actor.kind));
    conditions.push(eq(controlAuditEvents.actorId, actorId(input.actor)));
  }
  if (input.action) conditions.push(eq(controlAuditEvents.action, input.action));
  if (input.targetType) conditions.push(eq(controlAuditEvents.targetType, input.targetType));
  if (input.targetId) conditions.push(eq(controlAuditEvents.targetId, input.targetId));
  if (input.outcome) conditions.push(eq(controlAuditEvents.outcome, input.outcome));
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    const createdAt = new Date(cursor.createdAt);
    conditions.push(
      or(
        lt(controlAuditEvents.createdAt, createdAt),
        and(eq(controlAuditEvents.createdAt, createdAt), lt(controlAuditEvents.id, cursor.id)),
      ),
    );
  }

  const limit = pageSize(input.limit);
  const rows = await db
    .select()
    .from(controlAuditEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(controlAuditEvents.createdAt), desc(controlAuditEvents.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit && items.length > 0 ? encodeCursor(items[items.length - 1]!) : null,
  };
}
