// backend/src/notifications/digest-repo.ts
import { eq, desc } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { digests, type DigestRow } from "../db/schema.js";

export interface CreateDigestInput {
  personaId: string;
  routineId?: string | null;
  content: string;
}

export async function createDigest(db: DrizzleDb, input: CreateDigestInput): Promise<DigestRow> {
  const [row] = await db
    .insert(digests)
    .values({ personaId: input.personaId, routineId: input.routineId ?? null, content: input.content })
    .returning();
  return row;
}

export async function listDigests(db: DrizzleDb, personaId?: string): Promise<DigestRow[]> {
  const query = db.select().from(digests).orderBy(desc(digests.generatedAt));
  if (personaId) return query.where(eq(digests.personaId, personaId));
  return query;
}

export async function getDigest(db: DrizzleDb, id: string): Promise<DigestRow | undefined> {
  const [row] = await db.select().from(digests).where(eq(digests.id, id));
  return row;
}
