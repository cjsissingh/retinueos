import { describe, it, expect, beforeEach } from "vitest";
import { getSettings, resetSettingsCache } from "../src/config.js";

describe("getSettings", () => {
  beforeEach(() => {
    resetSettingsCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it("reads DATABASE_URL and AUTH_PASSWORD", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/retinueos_test";
    process.env.AUTH_PASSWORD = "secret";
    const settings = getSettings();
    expect(settings.databaseUrl).toBe("postgres://u:p@localhost/retinueos_test");
    expect(settings.authPassword).toBe("secret");
  });

  it("computes availableProviders from provider API key env vars", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/retinueos_test";
    process.env.AUTH_PASSWORD = "secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    const settings = getSettings();
    expect(settings.availableProviders).toContain("anthropic");
    expect(settings.availableProviders).not.toContain("openai");
  });

  it("reads a nonblank Brave Search API key", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/retinueos_test";
    process.env.AUTH_PASSWORD = "secret";
    process.env.BRAVE_SEARCH_API_KEY = "  brave-key  ";

    expect(getSettings().webSearchApiKey).toBe("brave-key");

    process.env.BRAVE_SEARCH_API_KEY = "  ";
    resetSettingsCache();
    expect(getSettings().webSearchApiKey).toBeUndefined();
  });

  it("throws when DATABASE_URL is missing", () => {
    delete process.env.DATABASE_URL;
    process.env.AUTH_PASSWORD = "secret";
    expect(() => getSettings()).toThrow(/DATABASE_URL/);
  });

  it("defaults backendUrl to http://localhost:8080 when BACKEND_URL is unset", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/retinueos_test";
    process.env.AUTH_PASSWORD = "secret";
    delete process.env.BACKEND_URL;
    resetSettingsCache();
    expect(getSettings().backendUrl).toBe("http://localhost:8080");
  });

  it("uses BACKEND_URL when set", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/retinueos_test";
    process.env.AUTH_PASSWORD = "secret";
    process.env.BACKEND_URL = "https://api.example.com";
    resetSettingsCache();
    expect(getSettings().backendUrl).toBe("https://api.example.com");
    delete process.env.BACKEND_URL;
    resetSettingsCache();
  });

  it("enables Web Push only when the complete VAPID tuple is configured", () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/retinueos_test";
    process.env.AUTH_PASSWORD = "secret";
    process.env.VAPID_PUBLIC_KEY = "public-key";
    process.env.VAPID_PRIVATE_KEY = "private-key";

    expect(getSettings().webPush).toBeUndefined();

    process.env.VAPID_SUBJECT = "mailto:owner@example.com";
    resetSettingsCache();
    expect(getSettings().webPush).toEqual({
      publicKey: "public-key",
      privateKey: "private-key",
      subject: "mailto:owner@example.com",
    });
  });
});
