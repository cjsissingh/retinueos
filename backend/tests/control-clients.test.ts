import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { requireControlClient, type ControlClientEnv } from "../src/auth/middleware.js";
import { resetSettingsCache } from "../src/config.js";
import {
  authenticateControlToken,
  createControlClient,
  listControlClients,
  revokeControlClient,
} from "../src/control/client-repo.js";
import { ControlClientCreateSchema } from "../src/control/client-schemas.js";
import { controlAuditEvents, controlClients } from "../src/db/schema.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();

async function insertClientFixtures(count: number): Promise<void> {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  await db()
    .insert(controlClients)
    .values(
      Array.from({ length: count }, (_, index) => ({
        name: `Client ${index}`,
        tokenHash: index.toString(16).padStart(64, "0"),
        tokenPrefix: index.toString().padStart(12, "0"),
        scopes: ["jobs:read"] as const,
        createdAt: new Date(base + index * 1000),
      })),
    );
}

describe("control-client token lifecycle", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-password";
    resetSettingsCache();
  });

  it("returns a correctly formatted token once and persists only its hash and display prefix", async () => {
    const created = await createControlClient(db(), { name: "Desktop client", scopes: ["routines:read"] });

    expect(created.token).toMatch(/^retinueos_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created.client).not.toHaveProperty("tokenHash");
    expect(created.client.tokenPrefix).toMatch(/^[A-Za-z0-9_-]{12}$/);

    const [stored] = await db().select().from(controlClients).where(eq(controlClients.id, created.client.id));
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toContain(created.token);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const listed = await listControlClients(db());
    expect(listed).toEqual({ items: [created.client], nextCursor: null });
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed.items[0]).not.toHaveProperty("tokenHash");
  });

  it("authenticates a valid token and rejects malformed or unknown tokens", async () => {
    const created = await createControlClient(db(), { name: "Desktop client", scopes: ["jobs:read", "audit:read"] });

    await expect(authenticateControlToken(db(), created.token)).resolves.toMatchObject({
      id: created.client.id,
      scopes: ["jobs:read", "audit:read"],
    });

    for (const token of [
      "",
      "retinueos_live_short_secret",
      `retinueos_test_${"a".repeat(12)}_${"b".repeat(43)}`,
      `retinueos_live_${"!".repeat(12)}_${"b".repeat(43)}`,
      `retinueos_live_${"a".repeat(12)}_${"b".repeat(42)}`,
      `retinueos_live_${"a".repeat(12)}_${"b".repeat(43)}`,
    ]) {
      await expect(authenticateControlToken(db(), token)).resolves.toBeUndefined();
    }
  });

  it("requires an Authorization bearer token and attaches the authenticated client row", async () => {
    const created = await createControlClient(db(), { name: "Desktop client", scopes: ["jobs:read"] });
    const app = new Hono<ControlClientEnv>();
    app.use("*", requireControlClient(db()));
    app.get("/", (c) => c.json({ clientId: c.get("controlClient").id }));

    const response = await app.request("/", {
      headers: { Authorization: `Bearer ${created.token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clientId: created.client.id });
  });

  it("revokes immediately and never returns token material from revocation", async () => {
    const created = await createControlClient(db(), { name: "Desktop client", scopes: ["jobs:read"] });

    const revoked = await revokeControlClient(db(), created.client.id);

    expect(revoked).toMatchObject({ id: created.client.id, revokedAt: expect.any(Date) });
    expect(revoked).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(revoked)).not.toContain(created.token);
    await expect(authenticateControlToken(db(), created.token)).resolves.toBeUndefined();
  });

  it("updates lastUsedAt at most once per hour", async () => {
    const created = await createControlClient(db(), { name: "Desktop client", scopes: ["routines:read"] });

    await authenticateControlToken(db(), created.token);
    const [firstUse] = await db().select().from(controlClients).where(eq(controlClients.id, created.client.id));
    expect(firstUse.lastUsedAt).toBeInstanceOf(Date);

    await authenticateControlToken(db(), created.token);
    const [secondUse] = await db().select().from(controlClients).where(eq(controlClients.id, created.client.id));
    expect(secondUse.lastUsedAt).toEqual(firstUse.lastUsedAt);

    const stale = new Date(Date.now() - 61 * 60 * 1000);
    await db().update(controlClients).set({ lastUsedAt: stale }).where(eq(controlClients.id, created.client.id));
    await authenticateControlToken(db(), created.token);
    const [refreshed] = await db().select().from(controlClients).where(eq(controlClients.id, created.client.id));
    expect(refreshed.lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("returns at most the default 50 clients in a page envelope", async () => {
    await insertClientFixtures(51);

    const page = await listControlClients(db());

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.items[0].name).toBe("Client 50");
    expect(page.items[49].name).toBe("Client 1");
    expect(JSON.stringify(page.items)).not.toContain("tokenHash");
  });

  it("caps an owner route page at 100 clients when the requested limit is larger", async () => {
    await insertClientFixtures(101);
    const app = createApp(undefined, db());

    const response = await app.request("/control/clients?limit=500", {
      headers: { "X-Auth-Password": "test-password" },
    });
    const page = await response.json();

    expect(response.status).toBe(200);
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("uses a stable descending createdAt and id cursor without skips or duplicates", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await db()
      .insert(controlClients)
      .values(
        [
          "00000000-0000-0000-0000-000000000001",
          "00000000-0000-0000-0000-000000000002",
          "00000000-0000-0000-0000-000000000003",
        ].map((id, index) => ({
          id,
          name: `Tied ${index + 1}`,
          tokenHash: (index + 1).toString(16).padStart(64, "f"),
          tokenPrefix: (index + 1).toString().padStart(12, "0"),
          scopes: ["jobs:read"] as const,
          createdAt,
        })),
      );

    const first = await listControlClients(db(), { limit: 2 });
    const second = await listControlClients(db(), { limit: 2, cursor: first.nextCursor! });

    expect(first.items.map((client) => client.id)).toEqual([
      "00000000-0000-0000-0000-000000000003",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(second.items.map((client) => client.id)).toEqual(["00000000-0000-0000-0000-000000000001"]);
    expect(second.nextCursor).toBeNull();
  });

  it("preserves PostgreSQL microseconds in the cursor boundary", async () => {
    const scopes = JSON.stringify(["jobs:read"]);
    await db().execute(sql`
      INSERT INTO control_clients (id, name, token_hash, token_prefix, scopes, created_at)
      VALUES
        (${"00000000-0000-0000-0000-000000000003"}::uuid, ${"Micro 3"}, ${"3".padStart(64, "f")}, ${"000000000003"}, ${scopes}::jsonb, ${"2026-01-01T00:00:00.000900+00:00"}::timestamptz),
        (${"00000000-0000-0000-0000-000000000002"}::uuid, ${"Micro 2"}, ${"2".padStart(64, "f")}, ${"000000000002"}, ${scopes}::jsonb, ${"2026-01-01T00:00:00.000900+00:00"}::timestamptz),
        (${"00000000-0000-0000-0000-000000000001"}::uuid, ${"Micro 1"}, ${"1".padStart(64, "f")}, ${"000000000001"}, ${scopes}::jsonb, ${"2026-01-01T00:00:00.000900+00:00"}::timestamptz),
        (${"00000000-0000-0000-0000-000000000009"}::uuid, ${"Earlier micro"}, ${"9".padStart(64, "f")}, ${"000000000009"}, ${scopes}::jsonb, ${"2026-01-01T00:00:00.000100+00:00"}::timestamptz)
    `);

    const first = await listControlClients(db(), { limit: 2 });
    const second = await listControlClients(db(), { limit: 2, cursor: first.nextCursor! });

    expect(first.items.map((client) => client.id)).toEqual([
      "00000000-0000-0000-0000-000000000003",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(second.items.map((client) => client.id)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000009",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(["cursor=not-a-cursor", "limit=not-a-number"])(
    "maps malformed owner list query %s to a controlled invalid-input response",
    async (query) => {
      const app = createApp(undefined, db());

      const response = await app.request(`/control/clients?${query}`, {
        headers: { "X-Auth-Password": "test-password" },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringMatching(/^invalid control client/) });
    },
  );

  it("accepts only scopes from the exact ControlScope union", () => {
    const validScopes = [
      "personas:read",
      "jobs:read",
      "jobs:write",
      "routines:read",
      "routines:write",
      "approvals:read",
      "approvals:write",
      "audit:read",
    ];

    expect(ControlClientCreateSchema.safeParse({ name: "All access", scopes: validScopes }).success).toBe(true);
    expect(ControlClientCreateSchema.safeParse({ name: "Bad", scopes: ["clients:write"] }).success).toBe(false);
    expect(ControlClientCreateSchema.safeParse({ name: "Bad", scopes: ["jobs:*"] }).success).toBe(false);
  });

  it("audits creation and revocation as trusted owner actions without secret material", async () => {
    const created = await createControlClient(db(), { name: "Desktop client", scopes: ["jobs:read"] });
    await revokeControlClient(db(), created.client.id);

    const events = await db()
      .select()
      .from(controlAuditEvents)
      .where(
        and(eq(controlAuditEvents.targetType, "control_client"), eq(controlAuditEvents.targetId, created.client.id)),
      );

    expect(events.map(({ actorKind, actorId, action, outcome }) => ({ actorKind, actorId, action, outcome }))).toEqual([
      { actorKind: "owner", actorId: "rest", action: "client.create", outcome: "succeeded" },
      { actorKind: "owner", actorId: "rest", action: "client.revoke", outcome: "succeeded" },
    ]);
    expect(JSON.stringify(events)).not.toContain(created.token);
    const secret = created.token.match(/_([A-Za-z0-9_-]{43})$/)?.[1];
    expect(secret).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain(secret!);
    expect(JSON.stringify(events)).not.toContain("tokenHash");
  });

  it("serves owner-authenticated create, list, and revoke routes without later token disclosure", async () => {
    const app = createApp(undefined, db());
    const unauthenticated = await app.request("/control/clients");
    expect(unauthenticated.status).toBe(401);

    const createdResponse = await app.request("/control/clients", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Auth-Password": "test-password" },
      body: JSON.stringify({ name: "Desktop client", scopes: ["routines:read"] }),
    });
    expect(createdResponse.status).toBe(201);
    const createdBody = await createdResponse.json();
    expect(createdBody.token).toMatch(/^retinueos_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/);
    expect(createdBody.client).not.toHaveProperty("tokenHash");

    const listResponse = await app.request("/control/clients", {
      headers: { "X-Auth-Password": "test-password" },
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.items).toHaveLength(1);
    expect(listBody.nextCursor).toBeNull();
    expect(listBody.items[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(listBody)).not.toContain(createdBody.token);

    const revokeResponse = await app.request(`/control/clients/${createdBody.client.id}`, {
      method: "DELETE",
      headers: { "X-Auth-Password": "test-password" },
    });
    expect(revokeResponse.status).toBe(200);
    const revokeBody = await revokeResponse.json();
    expect(revokeBody).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(revokeBody)).not.toContain(createdBody.token);
  });

  it("rejects invalid scopes at the owner route boundary", async () => {
    const app = createApp(undefined, db());
    const response = await app.request("/control/clients", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Auth-Password": "test-password" },
      body: JSON.stringify({ name: "Desktop client", scopes: ["routines:admin"] }),
    });

    expect(response.status).toBe(400);
    expect(await db().select({ id: controlClients.id }).from(controlClients)).toEqual([]);
  });
});
