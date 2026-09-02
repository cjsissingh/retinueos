import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { recordModelCall } from "../src/models/model-call-repo.js";
import { modelCallRoutes } from "../src/models/model-call-routes.js";

const { db } = useTestDb();

function buildApp() {
  const app = new Hono();
  app.route("/", modelCallRoutes(db()));
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

describe("GET /personas/:personaId/model_calls", () => {
  it("404s for a persona that doesn't exist", async () => {
    const app = buildApp();
    const res = await app.request("/personas/00000000-0000-0000-0000-000000000000/model_calls");
    expect(res.status).toBe(404);
  });

  it("returns recorded model calls for the persona", async () => {
    const app = buildApp();
    const persona = await makePersona();
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user", prompt: "hi" });

    const call = await recordModelCall(db(), {
      jobId: job.id,
      personaId: persona.id,
      provider: "anthropic",
      model: "claude-sonnet",
      finishReason: "stop",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      latencyMs: 842,
    });

    const res = await app.request(`/personas/${persona.id}/model_calls`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(call.id);
    expect(body[0].provider).toBe("anthropic");
    expect(body[0].totalTokens).toBe(150);
  });
});
