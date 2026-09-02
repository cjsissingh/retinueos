import { and, desc, eq, lt, or } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { personas, type PersonaRow } from "../db/schema.js";
import type { PersonaCreateInput, PersonaUpdateInput } from "./persona-schemas.js";
import { ControlError, type PageRequest, type PageResult } from "../control/types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface CreatedCursor {
  createdAt: string;
  id: string;
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function encodeCursor(row: PersonaRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}

function decodeCursor(cursor: string): CreatedCursor {
  try {
    // SAFETY: Cursor JSON is checked field-by-field before it is returned.
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CreatedCursor>;
    if (
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string" ||
      Number.isNaN(Date.parse(value.createdAt))
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new ControlError("invalid_input", "invalid persona cursor");
  }
}

export async function createPersona(db: DrizzleDb, input: PersonaCreateInput): Promise<PersonaRow> {
  const [row] = await db.insert(personas).values(input).returning();
  return row;
}

export async function listPersonas(db: DrizzleDb): Promise<PersonaRow[]> {
  return db.select().from(personas);
}

export async function listPersonasPage(db: DrizzleDb, page: PageRequest = {}): Promise<PageResult<PersonaRow>> {
  const conditions = [];
  if (page.cursor) {
    const cursor = decodeCursor(page.cursor);
    const createdAt = new Date(cursor.createdAt);
    conditions.push(
      or(lt(personas.createdAt, createdAt), and(eq(personas.createdAt, createdAt), lt(personas.id, cursor.id))),
    );
  }
  const limit = pageSize(page.limit);
  const rows = await db
    .select()
    .from(personas)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(personas.createdAt), desc(personas.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit && items.length ? encodeCursor(items.at(-1)!) : null };
}

export async function getPersona(db: DrizzleDb, id: string): Promise<PersonaRow | undefined> {
  const [row] = await db.select().from(personas).where(eq(personas.id, id));
  return row;
}

function normalizePersonaReference(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Resolve model-facing delegation references without ever comparing a
 * human-readable name or slug against PostgreSQL's UUID column. UUIDs remain
 * the durable identifier; names and derived slugs are accepted only when
 * they identify exactly one roster entry. */
export async function resolvePersonaReference(db: DrizzleDb, reference: string): Promise<PersonaRow | undefined> {
  const roster = await listPersonas(db);
  const id = reference.trim().toLowerCase();
  const byId = roster.find((persona) => persona.id === id);
  if (byId) return byId;

  const normalized = normalizePersonaReference(reference);
  if (!normalized) return undefined;
  const matches = roster.filter((persona) => normalizePersonaReference(persona.name) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Org chart: would setting `personaId`'s manager to `candidateManagerId`
 * create a reporting cycle (directly, or transitively through the
 * candidate's own chain of managers)? Also true for the trivial
 * self-reports-to-self case. Walks the `reportsTo` chain up from the
 * candidate; a chain is at most as long as the number of personas, so this
 * always terminates even if bad data somehow got in some other way.
 */
export async function wouldCreateReportingCycle(
  db: DrizzleDb,
  personaId: string,
  candidateManagerId: string,
): Promise<boolean> {
  if (candidateManagerId === personaId) return true;
  const all = await listPersonas(db);
  const byId = new Map(all.map((p) => [p.id, p]));
  let cursor: string | null = candidateManagerId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === personaId) return true;
    if (seen.has(cursor)) return false; // pre-existing bad data — don't loop forever
    seen.add(cursor);
    cursor = byId.get(cursor)?.reportsTo ?? null;
  }
  return false;
}

export async function updatePersona(
  db: DrizzleDb,
  id: string,
  input: PersonaUpdateInput,
): Promise<PersonaRow | undefined> {
  // Only set what was actually provided (`"reportsTo" in input`, not
  // `input.reportsTo !== undefined` — reportsTo's own valid values include
  // `null`, so a truthy/undefined check would wrongly drop an explicit
  // "clear the manager" patch). Every other field has no meaningful null, so
  // a plain undefined check is fine for those — including assignedToolIds,
  // which is a full-array replace, not a merge.
  const set: Partial<PersonaRow> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.role !== undefined) set.role = input.role;
  if (input.systemPrompt !== undefined) set.systemPrompt = input.systemPrompt;
  if (input.voiceNotes !== undefined) set.voiceNotes = input.voiceNotes;
  if (input.boundaries !== undefined) set.boundaries = input.boundaries;
  if (input.scopeDescription !== undefined) set.scopeDescription = input.scopeDescription;
  if (input.assignedToolIds !== undefined) set.assignedToolIds = input.assignedToolIds;
  if ("reportsTo" in input) set.reportsTo = input.reportsTo;
  if (input.modelProvider !== undefined) set.modelProvider = input.modelProvider;
  if (input.modelName !== undefined) set.modelName = input.modelName;

  // An empty patch (e.g. `{}`) has nothing to set — drizzle rejects an
  // empty `.set()`, and there's nothing to do anyway, so just return the
  // row as it stands.
  if (Object.keys(set).length === 0) return getPersona(db, id);

  const [row] = await db.update(personas).set(set).where(eq(personas.id, id)).returning();
  return row;
}
