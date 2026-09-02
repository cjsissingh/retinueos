import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { resetSettingsCache } from "../src/config.js";

describe("GET /config", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-password";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    resetSettingsCache();
  });

  it("requires auth like every other route", async () => {
    const app = createApp();
    const res = await app.request("/config");
    expect(res.status).toBe(401);
  });

  it("reports only the providers with an API key actually configured", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    resetSettingsCache();
    const app = createApp();
    const res = await app.request("/config", { headers: { "X-Auth-Password": "test-password" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.availableProviders).toEqual(["anthropic"]);
    expect(body.ready).toBe(true);
  });

  it("reports ready:false when no provider has a key configured", async () => {
    const app = createApp();
    const res = await app.request("/config", { headers: { "X-Auth-Password": "test-password" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ availableProviders: [], ready: false, webSearchAvailable: false });
  });

  it("reports whether Brave web search is available", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "brave-key";
    resetSettingsCache();
    const app = createApp();

    const res = await app.request("/config", { headers: { "X-Auth-Password": "test-password" } });

    expect(res.status).toBe(200);
    expect((await res.json()).webSearchAvailable).toBe(true);
  });
});
