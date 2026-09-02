// backend/src/notifications/digest-generator.ts
//
// createDigest() (digest-repo.ts) and listState() (persona-state-repo.ts)
// existed with no caller connecting them — the "surface anything that's
// been sitting for more than a day or two" rule. This is that caller: a
// template-based scan, not a model call. Deciding what a persona's
// *specific* named routines (Morning Digest, Inbox Sweep, ...) scan is out
// of scope here; this is the generic, always-available version: stale
// persona_state entries plus recent job outcomes, the same two loop-shaped
// things the app already tracks for every persona regardless of which tools
// it has. See docs/adr/0003-three-memory-stores.md.
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { jobs, type DigestRow, type JobRow, type PersonaStateRow } from "../db/schema.js";
import { getPersona } from "../personas/persona-repo.js";
import { listState } from "../personas/persona-state-repo.js";
import { createDigest } from "./digest-repo.js";
import { deliverNotification } from "./notify.js";
import { insertNotification, notificationTitle } from "./notification-repo.js";

/** State untouched for 24 hours is stale enough to surface in the next digest. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const RECENT_JOBS_SCANNED = 20;

export interface GenerateDigestOptions {
  routineId?: string | null;
  /** Pushes only when explicitly true. */
  push?: boolean;
}

function describeStaleState(row: PersonaStateRow): string {
  const days = Math.floor((Date.now() - row.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
  return `"${row.key}" (untouched ${days} day${days === 1 ? "" : "s"})`;
}

function summarize(personaName: string, stale: PersonaStateRow[], waiting: JobRow[], failed: JobRow[]): string {
  const sections: string[] = [];
  if (stale.length > 0) {
    sections.push(`Sitting untouched: ${stale.map(describeStaleState).join(", ")}.`);
  }
  if (waiting.length > 0) {
    sections.push(`Waiting on your approval: ${waiting.length} job${waiting.length === 1 ? "" : "s"}.`);
  }
  if (failed.length > 0) {
    sections.push(`Failed recently: ${failed.length} job${failed.length === 1 ? "" : "s"}.`);
  }
  return sections.length > 0 ? sections.join(" ") : `${personaName} has nothing new to report.`;
}

/**
 * Scans one persona's own loop state and recent job outcomes, writes the
 * full result as a durable `digests` row, and — unless `push: false` — also
 * writes a `routine_ran` notification whose push is gated by the delivery
 * matrix (toTeaser's own 200-char truncation applies at send time).
 */
export async function generateDigest(
  db: DrizzleDb,
  personaId: string,
  options: GenerateDigestOptions = {},
): Promise<DigestRow> {
  const persona = await getPersona(db, personaId);
  if (!persona) throw new Error(`no persona with id "${personaId}"`);

  const state = await listState(db, personaId);
  const stale = state.filter((row) => Date.now() - row.updatedAt.getTime() > STALE_AFTER_MS);

  const recentJobs = await db
    .select()
    .from(jobs)
    .where(eq(jobs.personaId, personaId))
    .orderBy(desc(jobs.updatedAt))
    .limit(RECENT_JOBS_SCANNED);
  const waiting = recentJobs.filter((j) => j.status === "waiting_approval");
  const failed = recentJobs.filter((j) => j.status === "failed");

  const content = summarize(persona.name, stale, waiting, failed);
  const digest = await createDigest(db, { personaId, routineId: options.routineId ?? null, content });

  if (options.push === true) {
    const notification = await insertNotification(db, {
      kind: "routine_ran",
      title: notificationTitle("routine_ran", persona.name),
      message: `${persona.name} digest: ${content}`,
      personaId,
    });
    await deliverNotification(db, notification);
  }

  return digest;
}
