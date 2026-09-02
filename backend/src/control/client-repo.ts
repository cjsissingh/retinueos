import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { controlClients, type ControlClientRow } from "../db/schema.js";
import { createControlAuditEvent } from "./control-repo.js";
import { ControlClientCreateSchema, type ControlClientCreateInput } from "./client-schemas.js";
import { ControlError, type PageRequest, type PageResult } from "./types.js";

const TOKEN_PATTERN = /^retinueos_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_KEY_PATTERN = /^-?\d{1,20}(?:\.\d{1,6})?$/;
const LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const owner = { kind: "owner", source: "rest" } as const;

export type PublicControlClient = Omit<ControlClientRow, "tokenHash">;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function publicControlClient({ tokenHash: _tokenHash, ...client }: ControlClientRow): PublicControlClient {
  return client;
}

function auditClient(client: PublicControlClient) {
  return {
    id: client.id,
    name: client.name,
    tokenPrefix: client.tokenPrefix,
    scopes: client.scopes,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
  };
}

export async function createControlClient(
  db: DrizzleDb,
  input: ControlClientCreateInput,
): Promise<{ client: PublicControlClient; token: string }> {
  const parsed = ControlClientCreateSchema.parse(input);
  const prefix = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const token = `retinueos_live_${prefix}_${secret}`;

  const client = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(controlClients)
      .values({ name: parsed.name, scopes: parsed.scopes, tokenPrefix: prefix, tokenHash: tokenHash(token) })
      .returning();
    const safe = publicControlClient(created);
    await createControlAuditEvent(tx, {
      actor: owner,
      action: "client.create",
      targetType: "control_client",
      targetId: created.id,
      after: auditClient(safe),
      outcome: "succeeded",
    });
    return safe;
  });

  return { client, token };
}

interface ClientCursor {
  createdAtKey: string;
  id: string;
}

const createdAtKey = sql`extract(epoch from ${controlClients.createdAt})`;

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function encodeCursor(cursor: ClientCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string): ClientCursor {
  try {
    // SAFETY: every field read from the untrusted decoded value is validated below before it is returned.
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ClientCursor>;
    if (
      typeof parsed.createdAtKey !== "string" ||
      typeof parsed.id !== "string" ||
      !TIMESTAMP_KEY_PATTERN.test(parsed.createdAtKey) ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAtKey: parsed.createdAtKey, id: parsed.id };
  } catch {
    throw new ControlError("invalid_input", "invalid control client cursor");
  }
}

export async function listControlClients(
  db: DrizzleDb,
  input: PageRequest = {},
): Promise<PageResult<PublicControlClient>> {
  const conditions = [];
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(
      or(
        sql`${createdAtKey} < ${cursor.createdAtKey}::numeric`,
        and(sql`${createdAtKey} = ${cursor.createdAtKey}::numeric`, lt(controlClients.id, cursor.id)),
      ),
    );
  }

  const limit = pageSize(input.limit);
  const rows = await db
    .select({
      id: controlClients.id,
      name: controlClients.name,
      tokenPrefix: controlClients.tokenPrefix,
      scopes: controlClients.scopes,
      createdAt: controlClients.createdAt,
      createdAtKey: sql<string>`${createdAtKey}::text`.as("created_at_key"),
      lastUsedAt: controlClients.lastUsedAt,
      revokedAt: controlClients.revokedAt,
    })
    .from(controlClients)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(controlClients.createdAt), desc(controlClients.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(({ createdAtKey: _createdAtKey, ...client }) => client);
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor({ createdAtKey: last.createdAtKey, id: last.id }) : null,
  };
}

export async function revokeControlClient(db: DrizzleDb, id: string): Promise<PublicControlClient | undefined> {
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(controlClients)
      .set({ revokedAt: new Date() })
      .where(and(eq(controlClients.id, id), isNull(controlClients.revokedAt)))
      .returning();

    if (!revoked) {
      const [existing] = await tx.select().from(controlClients).where(eq(controlClients.id, id));
      return existing ? publicControlClient(existing) : undefined;
    }

    const safe = publicControlClient(revoked);
    await createControlAuditEvent(tx, {
      actor: owner,
      action: "client.revoke",
      targetType: "control_client",
      targetId: revoked.id,
      before: auditClient({ ...safe, revokedAt: null }),
      after: auditClient(safe),
      outcome: "succeeded",
    });
    return safe;
  });
}

export async function authenticateControlToken(db: DrizzleDb, token: string): Promise<ControlClientRow | undefined> {
  if (!TOKEN_PATTERN.test(token)) return undefined;

  const digest = tokenHash(token);
  const [client] = await db
    .select()
    .from(controlClients)
    .where(and(eq(controlClients.tokenHash, digest), isNull(controlClients.revokedAt)));
  if (!client) return undefined;

  const threshold = new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS);
  if (client.lastUsedAt && client.lastUsedAt >= threshold) return client;

  const [updated] = await db
    .update(controlClients)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(controlClients.id, client.id),
        isNull(controlClients.revokedAt),
        or(isNull(controlClients.lastUsedAt), lt(controlClients.lastUsedAt, threshold)),
      ),
    )
    .returning();
  if (updated) return updated;

  const [active] = await db
    .select()
    .from(controlClients)
    .where(and(eq(controlClients.id, client.id), isNull(controlClients.revokedAt)));
  return active;
}
