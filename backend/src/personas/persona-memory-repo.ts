// backend/src/personas/persona-memory-repo.ts
//
// Durable fact memory (persona-memory-plan.md Phase 2) — small, independent,
// additive records, deliberately a separate table from persona_state's
// wholesale loop/task blobs. See schema.ts's comment on `personaMemories`
// for why the two stay split. Phase 4's reserved `job-summary:` rows live in
// this table for durable provenance, but are excluded from ordinary recall
// and automatic injection so one conversation cannot bleed into another.
import { and, desc, eq, gt, inArray, isNull, notLike, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { personaMemories, type PersonaMemoryRow, type NewPersonaMemoryRow } from "../db/schema.js";

export interface RememberInput {
  /** Caller-supplied id so a fenced remember can return the row id before the lease commit. */
  id?: string;
  personaId: string;
  label: string;
  content: string;
  sourceJobId?: string | null;
  sensitivity?: "normal" | "sensitive";
  importance?: 0 | 1 | 2;
  expiresAt?: Date | null;
}

export interface RecallOptions {
  limit?: number;
  /** recall() (the persona's own explicit lookup) defaults this to true — sensitivity gates *automatic* injection, not an explicit ask. Other callers default to false. */
  includeSensitive?: boolean;
}

const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_INJECTION_CHAR_BUDGET = 2000; // rough token-count proxy; no tokenizer dependency exists in this codebase yet
const DEFAULT_INJECTION_MAX_ROWS = 20; // upper bound so ranking never scans/sorts an unbounded table
export const JOB_SUMMARY_LABEL_PREFIX = "job-summary:";

/** This namespace belongs to thread hygiene, never to model-controlled fact-memory tools. */
export function isReservedMemoryLabel(label: string): boolean {
  return label.startsWith(JOB_SUMMARY_LABEL_PREFIX);
}

function assertGenericMemoryLabel(label: string): void {
  if (isReservedMemoryLabel(label)) {
    throw new Error(`memory labels beginning with "${JOB_SUMMARY_LABEL_PREFIX}" are reserved for thread hygiene`);
  }
}

/**
 * "Live" for every read path below: not superseded by a later remember()
 * under the same label, and not past its expiresAt. One shared predicate so
 * "live" means the same thing in recall, injection, and listing instead of
 * each caller re-deriving it slightly differently.
 */
function liveMemoryFilter(personaId: string) {
  return and(
    eq(personaMemories.personaId, personaId),
    isNull(personaMemories.supersededAt),
    or(isNull(personaMemories.expiresAt), gt(personaMemories.expiresAt, sql`now()`)),
  );
}

async function touchLastAccessed(db: DrizzleDb, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(personaMemories).set({ lastAccessedAt: new Date() }).where(inArray(personaMemories.id, ids));
}

/**
 * Writes a new memory, first superseding any live row under the same label
 * — additive versioning instead of write_state's overwrite-in-place, so a
 * persona can correct itself ("Operator moved to Seattle") without losing what
 * it used to believe. Superseding + inserting happens in one transaction so
 * two concurrent remember() calls under the same label can't both see "no
 * prior row" and leave two live rows behind.
 */
async function rememberMemoryUnchecked(db: DrizzleDb, input: RememberInput): Promise<PersonaMemoryRow> {
  return db.transaction(async (tx) => {
    const [prior] = await tx
      .select({ id: personaMemories.id })
      .from(personaMemories)
      .where(and(liveMemoryFilter(input.personaId), eq(personaMemories.label, input.label)));
    if (prior) {
      await tx.update(personaMemories).set({ supersededAt: new Date() }).where(eq(personaMemories.id, prior.id));
    }
    const values: NewPersonaMemoryRow = {
      personaId: input.personaId,
      label: input.label,
      content: input.content,
      sourceJobId: input.sourceJobId ?? null,
      supersedesId: prior?.id ?? null,
      sensitivity: input.sensitivity ?? "normal",
      importance: input.importance ?? 1,
      expiresAt: input.expiresAt ?? null,
    };
    if (input.id) values.id = input.id;
    const [row] = await tx.insert(personaMemories).values(values).returning();
    return row;
  });
}

export async function rememberMemory(db: DrizzleDb, input: RememberInput): Promise<PersonaMemoryRow> {
  assertGenericMemoryLabel(input.label);
  return rememberMemoryUnchecked(db, input);
}

/**
 * The sole internal write path for durable thread summaries. Taking jobId
 * rather than an arbitrary label/source pair makes namespace and provenance
 * inseparable; ordinary remember/promote operations cannot call this by
 * supplying model-controlled values.
 */
export async function rememberJobSummaryMemory(
  db: DrizzleDb,
  input: Omit<RememberInput, "label" | "sourceJobId"> & { jobId: string },
): Promise<PersonaMemoryRow> {
  return rememberMemoryUnchecked(db, {
    ...input,
    label: `${JOB_SUMMARY_LABEL_PREFIX}${input.jobId}`,
    sourceJobId: input.jobId,
  });
}

/**
 * Bounded keyword/full-text recall — Postgres `plainto_tsquery` over
 * label+content, ranked by text relevance first and recency as a
 * tie-breaker. Deliberately not "the N most recent memories that happen to
 * contain this substring": a persona with a hundred memories and a
 * two-word query should get the handful actually about the query. No
 * vector/embedding search — see persona-memory-plan.md's "explicitly out
 * of scope"; this is a new infrastructure dependency to add only if
 * keyword recall proves inadequate in practice, not preemptively.
 */
export async function recallMemories(
  db: DrizzleDb,
  personaId: string,
  query: string,
  options: RecallOptions = {},
): Promise<PersonaMemoryRow[]> {
  const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
  const tsVector = sql`to_tsvector('english', ${personaMemories.label} || ' ' || ${personaMemories.content})`;
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const sensitivityFilter = options.includeSensitive ? undefined : eq(personaMemories.sensitivity, "normal");

  const rows = await db
    .select()
    .from(personaMemories)
    .where(
      and(
        liveMemoryFilter(personaId),
        sensitivityFilter,
        notLike(personaMemories.label, `${JOB_SUMMARY_LABEL_PREFIX}%`),
        sql`${tsVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(sql`ts_rank(${tsVector}, ${tsQuery}) DESC`, desc(personaMemories.updatedAt))
    .limit(limit);

  await touchLastAccessed(
    db,
    rows.map((r) => r.id),
  );
  return rows;
}

/**
 * The bounded set of memories auto-injected into a persona's system prompt
 * at job start (graph/memory-context.ts) — the behavior that actually reads
 * as "it remembers," recall without the model first guessing a label.
 * Ranks by importance first, recency second, and stops filling once
 * `charBudget` is spent rather than a fixed row count, so one long memory
 * can't silently crowd out several short ones — except the single
 * highest-ranked memory always gets in even alone over budget, so one long
 * memory can't produce an empty injection either. Sensitive memories are
 * never auto-injected (see schema.ts's comment on `sensitivity`) — still
 * reachable through an explicit recall() call.
 */
export async function listMemoriesForInjection(
  db: DrizzleDb,
  personaId: string,
  charBudget: number = DEFAULT_INJECTION_CHAR_BUDGET,
): Promise<PersonaMemoryRow[]> {
  const candidates = await db
    .select()
    .from(personaMemories)
    .where(
      and(
        liveMemoryFilter(personaId),
        eq(personaMemories.sensitivity, "normal"),
        notLike(personaMemories.label, `${JOB_SUMMARY_LABEL_PREFIX}%`),
      ),
    )
    .orderBy(desc(personaMemories.importance), desc(personaMemories.updatedAt))
    .limit(DEFAULT_INJECTION_MAX_ROWS);

  const selected: PersonaMemoryRow[] = [];
  let spent = 0;
  for (const row of candidates) {
    const cost = row.label.length + row.content.length;
    if (selected.length > 0 && spent + cost > charBudget) break;
    selected.push(row);
    spent += cost;
  }

  await touchLastAccessed(
    db,
    selected.map((r) => r.id),
  );
  return selected;
}

/** Every live memory, most important then most recently updated first — the visibility/control surface (Memory tab, GET route) for what would otherwise only be readable by querying Postgres directly. */
export async function listMemories(db: DrizzleDb, personaId: string): Promise<PersonaMemoryRow[]> {
  return db
    .select()
    .from(personaMemories)
    .where(liveMemoryFilter(personaId))
    .orderBy(desc(personaMemories.importance), desc(personaMemories.updatedAt));
}

/** The live row under `label`, or undefined if none exists (never matches a superseded row) — the `promote_memory` tool's lookup of the caller's own memory before copying it up to a manager. */
export async function getLiveMemoryByLabel(
  db: DrizzleDb,
  personaId: string,
  label: string,
): Promise<PersonaMemoryRow | undefined> {
  const [row] = await db
    .select()
    .from(personaMemories)
    .where(and(liveMemoryFilter(personaId), eq(personaMemories.label, label)));
  return row;
}

/**
 * Deletes one memory outright by id, scoped to `personaId` so one persona
 * can't reach into another's memory. This is intentionally the user-facing
 * control-plane escape hatch for every visible row, including a bad reserved
 * summary; only model-controlled label operations are namespace-restricted.
 */
export async function forgetMemory(db: DrizzleDb, personaId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(personaMemories)
    .where(and(eq(personaMemories.personaId, personaId), eq(personaMemories.id, id)))
    .returning({ id: personaMemories.id });
  return deleted.length > 0;
}

/** Same as forgetMemory, addressed by label instead of id — the `forget_memory` tool's backing call, since the model has no reason to know a memory's row id. Deletes the live row under that label outright (not a supersede — this is real removal, not a correction). */
export async function forgetMemoryByLabel(db: DrizzleDb, personaId: string, label: string): Promise<boolean> {
  assertGenericMemoryLabel(label);
  const deleted = await db
    .delete(personaMemories)
    .where(and(liveMemoryFilter(personaId), eq(personaMemories.label, label)))
    .returning({ id: personaMemories.id });
  return deleted.length > 0;
}
