import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { writeState } from "../src/personas/persona-state-repo.js";
import { personaStateRoutes } from "../src/personas/persona-state-routes.js";

const { db } = useTestDb();

function buildApp() {
  const app = new Hono();
  app.route("/", personaStateRoutes(db()));
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

describe("GET /personas/:personaId/state", () => {
  it("lists a persona's loop-state keys with content, newest first", async () => {
    const app = buildApp();
    const persona = await makePersona();
    await writeState(db(), persona.id, "deliveries", "- widget, Tuesday");
    await writeState(db(), persona.id, "inbox-suggestions", "3 flagged");

    const res = await app.request(`/personas/${persona.id}/state`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ personaId: persona.id, key: "inbox-suggestions", content: "3 flagged" });
    expect(list[1]).toMatchObject({ personaId: persona.id, key: "deliveries", content: "- widget, Tuesday" });
  });

  it("returns an empty list when the persona has no state yet", async () => {
    const app = buildApp();
    const persona = await makePersona();
    const res = await app.request(`/personas/${persona.id}/state`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404s for a persona that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request("/personas/00000000-0000-0000-0000-000000000000/state");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /personas/:personaId/state/:key", () => {
  it("forgets one key and 204s", async () => {
    const app = buildApp();
    const persona = await makePersona();
    await writeState(db(), persona.id, "inbox-suggestions", "3 flagged");

    const res = await app.request(`/personas/${persona.id}/state/inbox-suggestions`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const remaining = await app.request(`/personas/${persona.id}/state`);
    expect(await remaining.json()).toEqual([]);
  });

  it("round-trips a key that needs URL encoding", async () => {
    const app = buildApp();
    const persona = await makePersona();
    await writeState(db(), persona.id, "waiting on you", "two items");

    const encoded = encodeURIComponent("waiting on you");
    const res = await app.request(`/personas/${persona.id}/state/${encoded}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("404s when the key isn't there", async () => {
    const app = buildApp();
    const persona = await makePersona();
    const res = await app.request(`/personas/${persona.id}/state/nope`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
