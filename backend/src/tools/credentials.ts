// backend/src/tools/credentials.ts
//
// App-level encryption for integration credentials (OAuth refresh tokens,
// API keys). Explicitly a different concern than the "never store or proxy
// LLM provider keys" rule (see models/router.ts) — that rule is about the
// model providers this app's own accounts talk to, not per-tool third-party
// integrations.
//
// AES-256-GCM, keyed from CREDENTIALS_ENCRYPTION_KEY (32 raw bytes, base64
// or hex encoded). Never stores plaintext; a missing/malformed key fails
// loudly at store/read time rather than silently falling back to plaintext.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../db/client.js";
import { credentials } from "../db/schema.js";
import type { CredentialPayload } from "./credential-schemas.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function loadKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY is not set — required to store or read integration credentials. " +
        "Generate one with `openssl rand -base64 32` and set it in your environment.",
    );
  }
  const key = raw.length === 64 && /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) — regenerate with ` +
        "`openssl rand -base64 32`.",
    );
  }
  return key;
}

// Exported so other server-scoped credential stores (mcp-server-repo.ts's
// bearer_token column) reuse this exact AES-256-GCM scheme instead of
// reimplementing it — same trust posture as docs/adr/0002-external-tools-via-mcp-adapters.md.
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv.authTag.ciphertext, each base64 — self-contained, no separate column needed.
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decrypt(encoded: string): string {
  const key = loadKey();
  const [ivB64, authTagB64, ciphertextB64] = encoded.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("stored credential payload is malformed (expected iv.authTag.ciphertext)");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

export async function storeCredential(db: DrizzleDb, toolId: string, payload: CredentialPayload): Promise<void> {
  const encryptedPayload = encrypt(JSON.stringify(payload));
  await db
    .insert(credentials)
    .values({ toolId, encryptedPayload })
    .onConflictDoUpdate({ target: credentials.toolId, set: { encryptedPayload, updatedAt: new Date() } });
}

export async function getCredential<T = CredentialPayload>(db: DrizzleDb, toolId: string): Promise<T | undefined> {
  const [row] = await db.select().from(credentials).where(eq(credentials.toolId, toolId));
  if (!row) return undefined;
  // SAFETY: this decrypts whatever `storeCredential` encrypted for the same
  // toolId, which only ever accepts a CredentialPayload -- callers narrowing
  // `T` further are trusting their own knowledge of what they stored for
  // that specific tool, the same way `getCredential`'s default does for
  // CredentialPayload itself.
  return JSON.parse(decrypt(row.encryptedPayload)) as T;
}

export async function hasCredential(db: DrizzleDb, toolId: string): Promise<boolean> {
  const [row] = await db.select().from(credentials).where(eq(credentials.toolId, toolId));
  return Boolean(row);
}

export async function deleteCredential(db: DrizzleDb, toolId: string): Promise<void> {
  await db.delete(credentials).where(eq(credentials.toolId, toolId));
}
