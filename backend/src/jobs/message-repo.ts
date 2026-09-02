// backend/src/jobs/message-repo.ts
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { messages, type MessageRow } from "../db/schema.js";
import { ControlError, type PageRequest, type PageResult } from "../control/types.js";

// Accepts a bare DrizzleDb or an open transaction -- every write site here
// (job-attempt-repo.ts's applyEffects, createQueuedJob, createClaimedChild,
// enqueueContinuation) already holds a `tx` it needs this insert to
// participate in, not a separate connection/transaction of its own.
type Queryable = Pick<DrizzleDb, "insert" | "select">;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
interface CreatedCursor {
  createdAt: string;
  id: string;
}
function pageSize(limit: number | undefined): number {
  return limit === undefined ? DEFAULT_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}
function decodeCursor(cursor: string): CreatedCursor {
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
    throw new ControlError("invalid_input", "invalid message cursor");
  }
}

export async function createMessage(
  db: Queryable,
  jobId: string,
  role: "user" | "assistant",
  content: string,
  at: Date = new Date(),
): Promise<MessageRow> {
  const [row] = await db.insert(messages).values({ jobId, role, content, createdAt: at }).returning();
  return row;
}

export async function listMessagesByJob(db: DrizzleDb, jobId: string): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.jobId, jobId)).orderBy(asc(messages.createdAt));
}

export async function listMessagesPageByJob(
  db: DrizzleDb,
  jobId: string,
  page: PageRequest = {},
): Promise<PageResult<MessageRow>> {
  const conditions = [eq(messages.jobId, jobId)];
  if (page.cursor) {
    const cursor = decodeCursor(page.cursor);
    const createdAt = new Date(cursor.createdAt);
    const afterCursor = or(
      lt(messages.createdAt, createdAt),
      and(eq(messages.createdAt, createdAt), lt(messages.id, cursor.id)),
    );
    if (afterCursor) conditions.push(afterCursor);
  }
  const limit = pageSize(page.limit);
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString("base64url")
        : null,
  };
}

/** The most recent assistant message on a job — what a settled delegate's
 *  real reply looks like to whoever delegated to it (dispatcher.ts's
 *  foldDelegateResult). */
export async function getLastAssistantMessage(db: DrizzleDb, jobId: string): Promise<MessageRow | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(eq(messages.jobId, jobId))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.role === "assistant" ? row : undefined;
}
