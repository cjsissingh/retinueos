// backend/src/personas/persona-state-repo.ts
//
// Semi-structured persona-owned loop/state storage: one row per (persona,
// key), with each value read and replaced as a whole. Keys stay independently
// addressable so personas can maintain several ongoing work streams.
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { personaState, type PersonaStateRow } from "../db/schema.js";

export async function readState(db: DrizzleDb, personaId: string, key: string): Promise<string> {
  const [row] = await db
    .select()
    .from(personaState)
    .where(and(eq(personaState.personaId, personaId), eq(personaState.key, key)));
  return row?.content ?? "";
}

export async function writeState(
  db: DrizzleDb,
  personaId: string,
  key: string,
  content: string,
): Promise<PersonaStateRow> {
  const [row] = await db
    .insert(personaState)
    .values({ personaId, key, content, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [personaState.personaId, personaState.key],
      set: { content, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** All of a persona's state entries, most-recently-updated first, so stale
 *  entries can be found without changing their stored content. */
export async function listState(db: DrizzleDb, personaId: string): Promise<PersonaStateRow[]> {
  return db
    .select()
    .from(personaState)
    .where(eq(personaState.personaId, personaId))
    .orderBy(desc(personaState.updatedAt));
}

/**
 * Deletes one key's row outright. Empty content remains an addressable state
 * entry, so `forget_state` must remove the row to keep forgotten keys out of
 * the persona's state index. The result says whether a row existed.
 */
export async function deleteState(db: DrizzleDb, personaId: string, key: string): Promise<boolean> {
  const deleted = await db
    .delete(personaState)
    .where(and(eq(personaState.personaId, personaId), eq(personaState.key, key)))
    .returning({ id: personaState.id });
  return deleted.length > 0;
}
