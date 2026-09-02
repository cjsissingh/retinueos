// backend/src/personas/routine-repo.ts
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { jobs, routines, type RoutineRow } from "../db/schema.js";

export type RoutineQueryable = Pick<DrizzleDb, "insert" | "select" | "update" | "delete">;

export interface CreateRoutineInput {
  personaId: string;
  name: string;
  cronSchedule: string;
  promptTemplate: string;
  notifyRoutineRan?: boolean;
  kind?: "job" | "digest";
  enabled?: boolean;
}

export async function createRoutine(db: RoutineQueryable, input: CreateRoutineInput): Promise<RoutineRow> {
  const [row] = await db
    .insert(routines)
    .values({
      personaId: input.personaId,
      name: input.name,
      cronSchedule: input.cronSchedule,
      promptTemplate: input.promptTemplate,
      notifyRoutineRan: input.notifyRoutineRan ?? false,
      kind: input.kind ?? "job",
      enabled: input.enabled ?? true,
    })
    .returning();
  return row;
}

export async function listRoutines(db: RoutineQueryable): Promise<RoutineRow[]> {
  return db.select().from(routines);
}

export async function listRoutinesByPersona(db: RoutineQueryable, personaId: string): Promise<RoutineRow[]> {
  return db.select().from(routines).where(eq(routines.personaId, personaId));
}

export async function getRoutine(db: RoutineQueryable, id: string): Promise<RoutineRow | undefined> {
  const [row] = await db.select().from(routines).where(eq(routines.id, id));
  return row;
}

export interface UpdateRoutineInput {
  name?: string;
  cronSchedule?: string;
  promptTemplate?: string;
  notifyRoutineRan?: boolean;
  enabled?: boolean;
  kind?: "job" | "digest";
}

export async function updateRoutine(
  db: RoutineQueryable,
  id: string,
  patch: UpdateRoutineInput,
): Promise<RoutineRow | undefined> {
  const [row] = await db.update(routines).set(patch).where(eq(routines.id, id)).returning();
  return row;
}

export async function updateRoutineFired(
  db: RoutineQueryable,
  id: string,
  lastSummary?: string,
): Promise<RoutineRow | undefined> {
  const values: Partial<typeof routines.$inferInsert> = { lastFiredAt: new Date() };
  if (lastSummary !== undefined) values.lastSummary = lastSummary;
  const [row] = await db.update(routines).set(values).where(eq(routines.id, id)).returning();
  return row;
}

export async function deleteRoutine(db: DrizzleDb, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteRoutineInTransaction(tx, id);
  });
}

export async function deleteRoutineInTransaction(db: RoutineQueryable, id: string): Promise<void> {
  // Attempt settlement locks attempt -> job -> routine. PostgreSQL's
  // ON DELETE SET NULL otherwise lets routine deletion lock routine -> job,
  // creating a cycle. Lock every referencing aggregate first in stable
  // order, then delete the routine.
  await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.routineId, id)).orderBy(jobs.id).for("update");
  await db.delete(routines).where(eq(routines.id, id));
}
