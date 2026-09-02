import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: vi.fn() };
});
const { generateObject } = await import("ai");

import { personaRoutes } from "../src/personas/persona-routes.js";
import { useTestDb } from "./setup/db.js";
import type { Settings } from "../src/config.js";

const { db } = useTestDb();

function settingsWith(availableProviders: string[]): Settings {
  return {
    databaseUrl: "postgres://test",
    authPassword: "test",
    availableProviders,
    frontendOrigin: "http://localhost:3000",
    backendUrl: "http://localhost:8080",
  };
}

function buildApp(settings: Settings) {
  const app = new Hono();
  app.route("/personas", personaRoutes(db(), undefined, settings));
  return app;
}

async function generate(app: Hono, body: Record<string, unknown>) {
  return app.request("/personas/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /personas/generate", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("422s when no Anthropic key is configured", async () => {
    const app = buildApp(settingsWith([]));
    const res = await generate(app, { description: "Someone to track my reading list" });
    expect(res.status).toBe(422);
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
  });

  it("400s on an empty description", async () => {
    const app = buildApp(settingsWith(["anthropic"]));
    const res = await generate(app, { description: "" });
    expect(res.status).toBe(400);
  });

  it("returns the model's draft, dropping any suggested tool that isn't actually registered", async () => {
    // SAFETY: generateObject is mocked above; this test only checks that
    // the route consumes `.object`, not the AI SDK's real return shape.
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        name: "Nova",
        role: "Reading Coach",
        systemPrompt: "Help track and discuss books.",
        voiceNotes: "Warm and curious.",
        boundaries: "Never spoils an ending.",
        scopeDescription: "Reading list tracking and discussion.",
        defaultTools: [
          { toolId: "remember", permission: "allow" },
          { toolId: "an_invented_tool_the_model_made_up", permission: "allow" },
        ],
      },
    } as never);

    const app = buildApp(settingsWith(["anthropic"]));
    const res = await generate(app, { description: "Someone to track my reading list" });
    expect(res.status).toBe(200);
    const draft = await res.json();
    expect(draft.name).toBe("Nova");
    expect(draft.defaultTools).toEqual([{ toolId: "remember", permission: "allow" }]);
  });

  it("502s when generation itself fails", async () => {
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("boom"));
    const app = buildApp(settingsWith(["anthropic"]));
    const res = await generate(app, { description: "Someone to track my reading list" });
    expect(res.status).toBe(502);
  });
});
