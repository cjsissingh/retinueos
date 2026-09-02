import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { notificationRoutes } from "../src/notifications/notification-routes.js";

const { db } = useTestDb();

function buildApp() {
  const app = new Hono();
  app.route("/", notificationRoutes(db()));
  return app;
}

async function makePersona() {
  return createPersona(db(), {
    name: "Assistant",
    role: "Chief of staff",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
}

describe("GET /digests", () => {
  it("lists persisted digests, newest first, optionally filtered by persona", async () => {
    const app = buildApp();
    const persona = await makePersona();
    const other = await createPersona(db(), {
      name: "Other",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    await app.request("/digests/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, push: false }),
    });
    await app.request("/digests/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: other.id, push: false }),
    });

    const all = await (await app.request("/digests")).json();
    expect(all).toHaveLength(2);

    const filtered = await (await app.request(`/digests?personaId=${persona.id}`)).json();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].personaId).toBe(persona.id);
  });
});

describe("GET /digests/:id", () => {
  it("returns one digest, and 404s when it isn't there", async () => {
    const app = buildApp();
    const persona = await makePersona();
    const created = await (
      await app.request("/digests/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, push: false }),
      })
    ).json();

    const res = await app.request(`/digests/${created.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(created.id);

    const missing = await app.request("/digests/00000000-0000-0000-0000-000000000000");
    expect(missing.status).toBe(404);
  });
});

describe("POST /digests/generate", () => {
  it("generates, persists, and returns a digest for a real persona", async () => {
    const app = buildApp();
    const persona = await makePersona();

    const res = await app.request("/digests/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, push: false }),
    });
    expect(res.status).toBe(201);
    const digest = await res.json();
    expect(digest.personaId).toBe(persona.id);

    const listRes = await app.request(`/digests?personaId=${persona.id}`);
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(digest.id);
  });

  it("400s when personaId is missing", async () => {
    const app = buildApp();
    const res = await app.request("/digests/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s for a persona that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request("/digests/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });
});
