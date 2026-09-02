// backend/src/orchestration/job-event-repo.ts
import { and, asc, eq, gt } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { jobEvents, type JobEventRow } from "../db/schema.js";
import type { JobEvent } from "./event-bus.js";

export async function recordJobEvent(db: DrizzleDb, jobId: string, event: JobEvent): Promise<JobEventRow> {
  const [row] = await db.insert(jobEvents).values({ jobId, event }).returning();
  return row;
}

/** Everything published for this job after `afterId` (exclusive), oldest first —
 *  the reconnect backlog stream-routes.ts replays before resuming live delivery. */
export async function listJobEventsAfter(db: DrizzleDb, jobId: string, afterId: number): Promise<JobEventRow[]> {
  return db
    .select()
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.id, afterId)))
    .orderBy(asc(jobEvents.id));
}
