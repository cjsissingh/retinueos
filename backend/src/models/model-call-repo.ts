// backend/src/models/model-call-repo.ts
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { modelCalls, type ModelCallRow } from "../db/schema.js";

// Persona telemetry view is a recent-activity window, not a full audit
// trail — matches digest-generator.ts's RECENT_JOBS_SCANNED pattern of
// bounding "recent" scans with a named constant rather than paginating.
const RECENT_MODEL_CALLS_LISTED = 100;

export interface RecordModelCallInput {
  jobId: string;
  personaId: string;
  provider: string;
  model: string;
  finishReason?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  latencyMs: number;
  error?: string | null;
}

export async function recordModelCall(db: DrizzleDb, input: RecordModelCallInput): Promise<ModelCallRow> {
  const [row] = await db
    .insert(modelCalls)
    .values({
      jobId: input.jobId,
      personaId: input.personaId,
      provider: input.provider,
      model: input.model,
      finishReason: input.finishReason ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      latencyMs: input.latencyMs,
      error: input.error ?? null,
    })
    .returning();
  return row;
}

export async function listModelCallsByJob(db: DrizzleDb, jobId: string): Promise<ModelCallRow[]> {
  return db.select().from(modelCalls).where(eq(modelCalls.jobId, jobId)).orderBy(desc(modelCalls.createdAt));
}

export async function listModelCallsByPersona(db: DrizzleDb, personaId: string): Promise<ModelCallRow[]> {
  return db
    .select()
    .from(modelCalls)
    .where(eq(modelCalls.personaId, personaId))
    .orderBy(desc(modelCalls.createdAt))
    .limit(RECENT_MODEL_CALLS_LISTED);
}
