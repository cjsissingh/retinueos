import { describe, it, expect } from "vitest";
import { McpServerCreateSchema } from "../src/tools/mcp-schemas.js";

describe("McpServerCreateSchema", () => {
  it("defaults authType to bearer when omitted (backward compatibility)", () => {
    const result = McpServerCreateSchema.safeParse({ name: "Fake", url: "https://93.184.216.34/mcp" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.authType).toBe("bearer");
  });

  it("accepts an explicit bearer payload with an optional token", () => {
    const result = McpServerCreateSchema.safeParse({
      authType: "bearer",
      name: "Fake",
      url: "https://93.184.216.34/mcp",
      bearerToken: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid oauth payload", () => {
    const result = McpServerCreateSchema.safeParse({
      authType: "oauth",
      name: "Gmail",
      url: "https://93.184.216.34/mcp",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthAuthorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      oauthTokenEndpoint: "https://93.184.216.34/token",
      oauthScope: "scope-a",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an oauth payload missing required OAuth fields", () => {
    const result = McpServerCreateSchema.safeParse({
      authType: "oauth",
      name: "Gmail",
      url: "https://93.184.216.34/mcp",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oauth payload whose token endpoint isn't a safe remote URL", () => {
    const result = McpServerCreateSchema.safeParse({
      authType: "oauth",
      name: "Gmail",
      url: "https://93.184.216.34/mcp",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthAuthorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      oauthTokenEndpoint: "https://127.0.0.1/token",
      oauthScope: "scope-a",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-HTTPS authorization endpoint", () => {
    const result = McpServerCreateSchema.safeParse({
      authType: "oauth",
      name: "Gmail",
      url: "https://93.184.216.34/mcp",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthAuthorizationEndpoint: "http://accounts.google.com/o/oauth2/v2/auth",
      oauthTokenEndpoint: "https://93.184.216.34/token",
      oauthScope: "scope-a",
    });
    expect(result.success).toBe(false);
  });
});
