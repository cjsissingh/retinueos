// backend/src/tool-calls/tool-call-repo.ts
import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { toolCalls, type ToolCallRow } from "../db/schema.js";
import type { RiskClass } from "../tools/registry.js";

export interface CreateToolCallInput {
  jobId: string;
  jobAttemptId?: string;
  callId?: string;
  toolId: string;
  riskClass: RiskClass;
  arguments: Record<string, unknown>;
  status?: ToolCallRow["status"];
  result?: Record<string, unknown> | null;
}

export async function createToolCall(db: DrizzleDb, input: CreateToolCallInput): Promise<ToolCallRow> {
  const values: typeof toolCalls.$inferInsert = {
    jobId: input.jobId,
    jobAttemptId: input.jobAttemptId ?? null,
    callId: input.callId ?? null,
    toolId: input.toolId,
    riskClass: input.riskClass,
    arguments: input.arguments,
  };
  if (input.status) values.status = input.status;
  if (input.result !== undefined) values.result = input.result;
  const [row] = await db.insert(toolCalls).values(values).returning();
  return row;
}

export async function getToolCall(db: DrizzleDb, id: string): Promise<ToolCallRow | undefined> {
  const [row] = await db.select().from(toolCalls).where(eq(toolCalls.id, id));
  return row;
}

/**
 * Writes a gated call's real outcome back onto the row `createToolCall`
 * already made at interrupt time — found by (jobId, callId), the model
 * tool-call id, since that's the only handle Phase 2 execution has on which
 * DB row this was (see graph/persona-graph.ts's onToolExecuted). A miss
 * (no matching row) is logged, not thrown — the tool already ran; losing the
 * audit write shouldn't also fail the job.
 */
export async function completeToolCallByCallId(
  db: DrizzleDb,
  jobId: string,
  callId: string,
  status: "executed" | "failed",
  result: Record<string, unknown>,
): Promise<ToolCallRow | undefined> {
  const [row] = await db
    .update(toolCalls)
    .set({ status, result })
    .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.callId, callId)))
    .returning();
  if (!row) {
    console.error(`completeToolCallByCallId: no tool_calls row found for job ${jobId} callId ${callId}`);
  }
  return row;
}

export async function listToolCallsByStatus(db: DrizzleDb, status: ToolCallRow["status"]): Promise<ToolCallRow[]> {
  return db.select().from(toolCalls).where(eq(toolCalls.status, status));
}

export async function listToolCallsByJob(db: DrizzleDb, jobId: string): Promise<ToolCallRow[]> {
  return db.select().from(toolCalls).where(eq(toolCalls.jobId, jobId));
}

export async function listAllToolCalls(db: DrizzleDb): Promise<ToolCallRow[]> {
  return db.select().from(toolCalls);
}
