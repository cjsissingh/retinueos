import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { useTestDb } from "./setup/db.js";
import { storeCredential, getCredential, hasCredential, deleteCredential } from "../src/tools/credentials.js";

const { db } = useTestDb();

beforeAll(() => {
  // A fixed 32-byte key for test determinism — real deployments generate
  // their own via `openssl rand -base64 32` (see credentials.ts).
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("credentials store", () => {
  it("round-trips an encrypted payload", async () => {
    expect(await hasCredential(db(), "google")).toBe(false);
    await storeCredential(db(), "google", { clientId: "id", clientSecret: "secret", refreshToken: "rt" });
    expect(await hasCredential(db(), "google")).toBe(true);
    const cred = await getCredential<{ clientId: string; refreshToken: string }>(db(), "google");
    expect(cred?.clientId).toBe("id");
    expect(cred?.refreshToken).toBe("rt");
  });

  it("never stores the plaintext payload in the encrypted_payload column", async () => {
    await storeCredential(db(), "google", { refreshToken: "super-secret-token" });
    const rows = await db().execute<{ encrypted_payload: string }>(
      sql`SELECT encrypted_payload FROM credentials WHERE tool_id = 'google'`,
    );
    expect(rows[0]!.encrypted_payload).not.toContain("super-secret-token");
  });

  it("upserts on a second store for the same toolId", async () => {
    await storeCredential(db(), "google", { refreshToken: "first" });
    await storeCredential(db(), "google", { refreshToken: "second" });
    const cred = await getCredential<{ refreshToken: string }>(db(), "google");
    expect(cred?.refreshToken).toBe("second");
  });

  it("deleteCredential removes it", async () => {
    await storeCredential(db(), "google", { refreshToken: "x" });
    await deleteCredential(db(), "google");
    expect(await hasCredential(db(), "google")).toBe(false);
  });
});
