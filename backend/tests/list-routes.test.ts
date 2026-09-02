import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { jobRoutes } from "../src/jobs/job-routes.js";

const { db } = useTestDb();

describe("GET /jobs?personaId=", () => {
  it("filters jobs by persona", async () => {
    const app = new Hono();
    app.route("/jobs", jobRoutes(db(), undefined));

    const p1 = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const p2 = await createPersona(db(), {
      name: "B",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    await createJob(db(), { personaId: p1.id, depth: 0, origin: "user" });
    await createJob(db(), { personaId: p2.id, depth: 0, origin: "user" });

    const res = await app.request(`/jobs?personaId=${p1.id}`);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].personaId).toBe(p1.id);
  });
});

describe("GET /jobs?parentJobId=", () => {
  it("returns only the chats delegated by the selected parent chat", async () => {
    const app = new Hono();
    app.route("/jobs", jobRoutes(db(), undefined));

    const manager = await createPersona(db(), {
      name: "Manager",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const delegate = await createPersona(db(), {
      name: "Delegate",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const parent = await createJob(db(), { personaId: manager.id, depth: 0, origin: "user" });
    const otherParent = await createJob(db(), { personaId: manager.id, depth: 0, origin: "user" });
    const child = await createJob(db(), {
      personaId: delegate.id,
      parentJobId: parent.id,
      depth: 1,
      origin: "delegation",
    });
    await createJob(db(), {
      personaId: delegate.id,
      parentJobId: otherParent.id,
      depth: 1,
      origin: "delegation",
    });

    const res = await app.request(`/jobs?parentJobId=${parent.id}`);
    const list = await res.json();

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(child.id);
  });
});
