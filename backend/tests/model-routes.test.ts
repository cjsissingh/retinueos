import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetSettingsCache } from "../src/config.js";
import { resetModelCatalogCache } from "../src/models/model-catalog.js";

// Test fixture standing in for a provider's JSON response body, deliberately
// varied per test case -- there's no one shape to name here.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GET /models", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-password";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetSettingsCache();
    resetModelCatalogCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires auth like every other route", async () => {
    const app = createApp();
    const res = await app.request("/models");
    expect(res.status).toBe(401);
  });

  it("returns an empty list per provider when no keys are configured, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp();

    const res = await app.request("/models", { headers: { "X-Auth-Password": "test-password" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and returns the configured provider's live model list", async () => {
    process.env.OPENAI_API_KEY = "sk-x";
    resetSettingsCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "gpt-5.6-sol" }] })));
    const app = createApp();

    const res = await app.request("/models", { headers: { "X-Auth-Password": "test-password" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: { openai: ["gpt-5.6-sol"] } });
  });
});
