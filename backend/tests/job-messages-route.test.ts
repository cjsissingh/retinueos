import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { personaRoutes } from "../src/personas/persona-routes.js";
import { jobRoutes } from "../src/jobs/job-routes.js";
import { createMessage } from "../src/jobs/message-repo.js";

const { db } = useTestDb();

function buildApp(): Hono {
  const app = new Hono();
  app.route("/personas", personaRoutes(db()));
  app.route("/jobs", jobRoutes(db()));
  return app;
}

describe("GET /jobs/:id/messages", () => {
  it("404s for a job that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request("/jobs/00000000-0000-0000-0000-000000000000/messages");
    expect(res.status).toBe(404);
  });

  it("returns the seeded prompt as the first message, oldest first", async () => {
    const app = buildApp();
    const personaRes = await app.request("/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [],
      }),
    });
    const persona = await personaRes.json();
    const jobRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hello there" }),
    });
    const job = await jobRes.json();
    await createMessage(db(), job.id, "assistant", "hi back", new Date(Date.now() + 1000));

    const res = await app.request(`/jobs/${job.id}/messages`);
    expect(res.status).toBe(200);
    const messages = await res.json();
    expect(messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "hello there"],
      ["assistant", "hi back"],
    ]);
  });
});
