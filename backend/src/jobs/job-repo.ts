// backend/src/jobs/job-repo.ts
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { jobs, toolCalls, type JobRow, type JobStartOrigin, type ToolCallRow } from "../db/schema.js";
import { createMessage } from "./message-repo.js";
import { ControlError, type PageRequest, type PageResult } from "../control/types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
interface CreatedCursor {
  createdAt: string;
  id: string;
}
export interface JobListFilters {
  personaId?: string;
  parentJobId?: string;
}
function pageSize(limit: number | undefined): number {
  return limit === undefined ? DEFAULT_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}
function decodeCursor(cursor: string, name: string): CreatedCursor {
  try {
    // SAFETY: Cursor JSON is checked field-by-field before it is returned.
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CreatedCursor>;
    if (
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      Number.isNaN(Date.parse(value.createdAt))
    )
      throw new Error("invalid cursor");
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new ControlError("invalid_input", `invalid ${name} cursor`);
  }
}

export interface CreateJobInput {
  personaId: string;
  parentJobId?: string | null;
  routineId?: string | null;
  depth: number;
  origin: JobStartOrigin;
  prompt?: string | null;
}

export async function createJob(db: DrizzleDb, input: CreateJobInput): Promise<JobRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(jobs)
      .values({
        personaId: input.personaId,
        parentJobId: input.parentJobId ?? null,
        routineId: input.routineId ?? null,
        depth: input.depth,
        origin: input.origin,
        prompt: input.prompt ?? null,
        langgraphThreadId: randomUUID(),
        status: "queued",
      })
      .returning();
    // Seed the message history with the opening prompt so a chat's first
    // turn is never missing from its own history -- nothing else writes a
    // user message for this job's creation, so if it's skipped here the
    // very first thing this chat was asked to do would exist only in the
    // `prompt` column, invisible to the messages timeline a chat view
    // actually renders.
    if (input.prompt) await createMessage(tx, row.id, "user", input.prompt);
    return row;
  });
}

export async function getJob(db: DrizzleDb, id: string): Promise<JobRow | undefined> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

// `error` is only meaningful for status "failed". Keeping it on the guarded
// transition makes status + failure detail one atomic write. A successful
// transition clears any error left by a prior turn on this chat.
export async function transitionJobStatus(
  db: DrizzleDb,
  id: string,
  expectedStatus: JobRow["status"],
  status: JobRow["status"],
  error?: string | null,
): Promise<JobRow | undefined> {
  const [row] = await db
    .update(jobs)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, expectedStatus)))
    .returning();
  return row;
}

/** Atomically grants one executor ownership of a fresh job. */
export function claimQueuedJob(db: DrizzleDb, id: string): Promise<JobRow | undefined> {
  return transitionJobStatus(db, id, "queued", "running");
}

export async function listJobs(db: DrizzleDb): Promise<JobRow[]> {
  return db.select().from(jobs);
}

export async function listJobsByFilters(db: DrizzleDb, filters: JobListFilters): Promise<JobRow[]> {
  const conditions = [];
  if (filters.personaId) conditions.push(eq(jobs.personaId, filters.personaId));
  if (filters.parentJobId) conditions.push(eq(jobs.parentJobId, filters.parentJobId));
  return db
    .select()
    .from(jobs)
    .where(conditions.length ? and(...conditions) : undefined);
}

export async function listJobsPage(
  db: DrizzleDb,
  page: PageRequest = {},
  filters: JobListFilters = {},
): Promise<PageResult<JobRow>> {
  const conditions = [];
  if (filters.personaId) conditions.push(eq(jobs.personaId, filters.personaId));
  if (filters.parentJobId) conditions.push(eq(jobs.parentJobId, filters.parentJobId));
  if (page.cursor) {
    const cursor = decodeCursor(page.cursor, "job");
    const createdAt = new Date(cursor.createdAt);
    const afterCursor = or(lt(jobs.createdAt, createdAt), and(eq(jobs.createdAt, createdAt), lt(jobs.id, cursor.id)));
    if (afterCursor) conditions.push(afterCursor);
  }
  const limit = pageSize(page.limit);
  const rows = await db
    .select()
    .from(jobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit && items.length ? encodeCursor(items.at(-1)!) : null };
}

export async function listPendingToolCallsPage(
  db: DrizzleDb,
  jobId: string,
  page: PageRequest = {},
): Promise<PageResult<ToolCallRow>> {
  const conditions = [eq(toolCalls.jobId, jobId), eq(toolCalls.status, "pending_approval")];
  if (page.cursor) {
    const cursor = decodeCursor(page.cursor, "pending approval");
    const createdAt = new Date(cursor.createdAt);
    const afterCursor = or(
      lt(toolCalls.createdAt, createdAt),
      and(eq(toolCalls.createdAt, createdAt), lt(toolCalls.id, cursor.id)),
    );
    if (afterCursor) conditions.push(afterCursor);
  }
  const limit = pageSize(page.limit);
  const rows = await db
    .select()
    .from(toolCalls)
    .where(and(...conditions))
    .orderBy(desc(toolCalls.createdAt), desc(toolCalls.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit && items.length ? encodeCursor(items.at(-1)!) : null };
}
