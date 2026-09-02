import { describe, it, expect } from "vitest";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { Hono } from "hono";
import "../src/tools/builtin.js";

const { db } = useTestDb();

function buildApp() {
  const app = new Hono();
  app.route("/personas", personaRoutes(db()));
  return app;
}

interface HireBody {
  name: string;
  role: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  assignedToolIds: string[];
  reportsTo?: string;
}

async function hire(app: Hono, name: string, reportsTo?: string) {
  const body: HireBody = {
    name,
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  };
  if (reportsTo) body.reportsTo = reportsTo;
  const res = await app.request("/personas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

describe("persona routes", () => {
  it("creates and lists a persona", async () => {
    const app = buildApp();
    const createRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Assistant",
        role: "Principal",
        systemPrompt: "You are the Principal.",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        assignedToolIds: [{ toolId: "delegate_to" }],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe("Assistant");
    expect(created.status).toBe("idle");
    // The service's internal `(createdAt, id)` cursor key is not a REST
    // representation change.
    expect(created).not.toHaveProperty("createdAt");

    const listRes = await app.request("/personas");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("createdAt");
  });

  it("returns 404 for an unknown persona id", async () => {
    const app = buildApp();
    const res = await app.request("/personas/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid create payload", async () => {
    const app = buildApp();
    const res = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a persona reporting to an existing one", async () => {
    const app = buildApp();
    const principal = await (await hire(app, "Assistant")).json();
    const res = await hire(app, "Budget Advisor", principal.id);
    expect(res.status).toBe(201);
    const advisor = await res.json();
    expect(advisor.reportsTo).toBe(principal.id);
  });

  it("rejects creating a persona that reports to a nonexistent manager", async () => {
    const app = buildApp();
    const res = await hire(app, "Budget Advisor", "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(400);
  });

  it("reassigns a persona's manager via PATCH", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const b = await (await hire(app, "B")).json();
    const patchRes = await app.request(`/personas/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportsTo: a.id }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.reportsTo).toBe(a.id);
  });

  it("promotes a persona to the top of the chart via PATCH with null", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const b = await (await hire(app, "B", a.id)).json();
    const patchRes = await app.request(`/personas/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportsTo: null }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.reportsTo).toBeNull();
  });

  it("rejects a PATCH that would create a reporting cycle", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const b = await (await hire(app, "B", a.id)).json();
    // A reports to B would make A -> B -> A a cycle.
    const patchRes = await app.request(`/personas/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportsTo: b.id }),
    });
    expect(patchRes.status).toBe(400);
  });

  it("rejects a PATCH where a persona would report to itself", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const patchRes = await app.request(`/personas/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportsTo: a.id }),
    });
    expect(patchRes.status).toBe(400);
  });

  it("fixes a persona's model via PATCH", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const patchRes = await app.request(`/personas/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelProvider: "openai", modelName: "gpt-5" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.modelProvider).toBe("openai");
    expect(updated.modelName).toBe("gpt-5");
  });

  it("a model PATCH leaves reportsTo untouched", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const b = await (await hire(app, "B", a.id)).json();
    const patchRes = await app.request(`/personas/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelProvider: "openai", modelName: "gpt-5" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.reportsTo).toBe(a.id);
  });

  it("edits identity and charter fields via PATCH", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const patchRes = await app.request(`/personas/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A2",
        role: "Renamed role",
        systemPrompt: "New purpose",
        voiceNotes: "Dry, terse",
        boundaries: "Never sends money",
        scopeDescription: "Inbox triage only",
      }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.name).toBe("A2");
    expect(updated.role).toBe("Renamed role");
    expect(updated.systemPrompt).toBe("New purpose");
    expect(updated.voiceNotes).toBe("Dry, terse");
    expect(updated.boundaries).toBe("Never sends money");
    expect(updated.scopeDescription).toBe("Inbox triage only");
  });

  it("replaces assignedToolIds via PATCH", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const patchRes = await app.request(`/personas/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedToolIds: [{ toolId: "send_email" }, { toolId: "gmail_search" }] }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.assignedToolIds).toEqual([
      { toolId: "send_email", permission: "ask", autonomy: "approval_required" },
      { toolId: "gmail_search", permission: "allow" },
    ]);
  });

  it("coerces a destructive tool requested as Allow to Ask on write", async () => {
    const app = buildApp();
    const createRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [{ toolId: "send_email", permission: "allow" }],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.assignedToolIds).toEqual([
      { toolId: "send_email", permission: "ask", autonomy: "approval_required" },
    ]);
  });

  it("rejects a PATCH with an empty name or role", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const res = await app.request(`/personas/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("a charter PATCH leaves reportsTo and model untouched", async () => {
    const app = buildApp();
    const a = await (await hire(app, "A")).json();
    const b = await (await hire(app, "B", a.id)).json();
    const patchRes = await app.request(`/personas/${b.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boundaries: "Never gives investment advice" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.reportsTo).toBe(a.id);
    expect(updated.modelProvider).toBe("anthropic");
    expect(updated.modelName).toBe("m");
  });

  it("returns 404 for a PATCH on an unknown persona id", async () => {
    const app = buildApp();
    const res = await app.request("/personas/00000000-0000-0000-0000-000000000000", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportsTo: null }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /personas/templates lists the starter templates, not confused with a persona id lookup", async () => {
    const app = buildApp();
    const res = await app.request("/personas/templates");
    expect(res.status).toBe(200);
    const templates = await res.json();
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const template of templates) {
      expect(typeof template.slug).toBe("string");
      expect(typeof template.name).toBe("string");
      expect(Array.isArray(template.defaultTools)).toBe(true);
    }
  });

  it("still resolves a real persona id at GET /personas/:id after adding the templates route", async () => {
    const app = buildApp();
    const created = await (await hire(app, "Wren")).json();
    const res = await app.request(`/personas/${created.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Wren");
  });
});
