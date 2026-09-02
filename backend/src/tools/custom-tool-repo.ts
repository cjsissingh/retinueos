// backend/src/tools/custom-tool-repo.ts
//
// CRUD for custom_tool_proposals (custom-script sandbox / Tier 2).
// Existence approval only: nothing in this file executes a script or
// registers a ToolSpec.
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { customToolProposals, type CustomToolProposalRow } from "../db/schema.js";

export interface CustomToolProposalInput {
  description: string;
  source: string;
  parametersSchema: Record<string, unknown>;
  hostAllowList: string[];
  secretRefs: string[];
  limits: { timeoutMs: number; memoryMb: number; maxOutputBytes: number };
  suggestedRiskClass: string;
}

export async function createCustomTool(
  db: DrizzleDb,
  toolKey: string,
  input: CustomToolProposalInput,
): Promise<CustomToolProposalRow> {
  const existing = await db
    .select({ id: customToolProposals.id })
    .from(customToolProposals)
    .where(eq(customToolProposals.toolKey, toolKey))
    .limit(1);
  if (existing.length > 0) throw new Error(`custom tool "${toolKey}" already exists`);
  const [row] = await db
    .insert(customToolProposals)
    .values({ toolKey, version: 1, ...input })
    .returning();
  if (!row) throw new Error("insert into custom_tool_proposals returned no row");
  return row;
}

// Wrapped in a transaction so the "read the latest version, insert the
// next one" pair is atomic against a concurrent version create for the
// same toolKey — a race would otherwise be able to compute the same next
// version twice (the unique index still prevents corrupting data if that
// happens, but the loser should see a clear error, not a silent retry).
export async function createCustomToolVersion(
  db: DrizzleDb,
  toolKey: string,
  input: CustomToolProposalInput,
): Promise<CustomToolProposalRow> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ version: customToolProposals.version })
      .from(customToolProposals)
      .where(eq(customToolProposals.toolKey, toolKey))
      .orderBy(desc(customToolProposals.version))
      .limit(1);
    if (!latest) throw new Error(`custom tool "${toolKey}" not found`);
    const [row] = await tx
      .insert(customToolProposals)
      .values({ toolKey, version: latest.version + 1, ...input })
      .returning();
    if (!row) throw new Error("insert into custom_tool_proposals returned no row");
    return row;
  });
}

/** One row per toolKey — its latest version — for the tool-list view.
 *  Small expected row count (operator-managed scripts, not a discovered
 *  catalog), so deduping in JS after one ordered SELECT is simpler than a
 *  DISTINCT ON query and behaves identically. */
export async function listCustomTools(db: DrizzleDb): Promise<CustomToolProposalRow[]> {
  const rows = await db
    .select()
    .from(customToolProposals)
    .orderBy(customToolProposals.toolKey, desc(customToolProposals.version));
  const latestByKey = new Map<string, CustomToolProposalRow>();
  for (const row of rows) if (!latestByKey.has(row.toolKey)) latestByKey.set(row.toolKey, row);
  return [...latestByKey.values()];
}

export async function listCustomToolVersions(db: DrizzleDb, toolKey: string): Promise<CustomToolProposalRow[]> {
  return db
    .select()
    .from(customToolProposals)
    .where(eq(customToolProposals.toolKey, toolKey))
    .orderBy(customToolProposals.version);
}

export async function getCustomToolVersion(
  db: DrizzleDb,
  toolKey: string,
  version: number,
): Promise<CustomToolProposalRow | undefined> {
  const [row] = await db
    .select()
    .from(customToolProposals)
    .where(and(eq(customToolProposals.toolKey, toolKey), eq(customToolProposals.version, version)));
  return row;
}

export type CustomToolReviewOutcome =
  | { outcome: "not_found" }
  | { outcome: "not_pending"; row: CustomToolProposalRow }
  | { outcome: "ok"; row: CustomToolProposalRow };

/** Atomic conditional UPDATE — the WHERE clause includes status='pending',
 *  so a decision is applied and read back in the same statement rather
 *  than a read-then-write that a concurrent reviewer could race. Returns
 *  not_pending (with the current row) instead of silently overwriting an
 *  already-decided version — a decision, once made, is history. */
export async function reviewCustomToolVersion(
  db: DrizzleDb,
  toolKey: string,
  version: number,
  input: { status: "approved" | "rejected"; reviewNote?: string },
): Promise<CustomToolReviewOutcome> {
  const [updated] = await db
    .update(customToolProposals)
    .set({ status: input.status, reviewNote: input.reviewNote ?? null, reviewedAt: new Date() })
    .where(
      and(
        eq(customToolProposals.toolKey, toolKey),
        eq(customToolProposals.version, version),
        eq(customToolProposals.status, "pending"),
      ),
    )
    .returning();
  if (updated) return { outcome: "ok", row: updated };
  const existing = await getCustomToolVersion(db, toolKey, version);
  if (!existing) return { outcome: "not_found" };
  return { outcome: "not_pending", row: existing };
}
