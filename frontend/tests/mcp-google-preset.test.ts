import { describe, it, expect } from "vitest";
import {
  canRediscoverMcpServer,
  inferGoogleOAuthScope,
  oauthConnectLabel,
  GOOGLE_OAUTH_AUTHORIZATION_ENDPOINT,
  GOOGLE_OAUTH_TOKEN_ENDPOINT,
} from "../app/settings/mcp/mcp-settings-content";

describe("inferGoogleOAuthScope", () => {
  it("infers Gmail scopes from a gmailmcp.googleapis.com URL", () => {
    expect(inferGoogleOAuthScope("https://gmailmcp.googleapis.com/mcp/v1")).toContain("gmail.readonly");
  });

  it("infers Calendar scopes from a calendarmcp.googleapis.com URL", () => {
    expect(inferGoogleOAuthScope("https://calendarmcp.googleapis.com/mcp/v1")).toContain("calendar");
  });

  it("returns an empty string for an unrecognized URL", () => {
    expect(inferGoogleOAuthScope("https://example.com/mcp")).toBe("");
  });

  it.each([
    "https://gmailmcp.googleapis.com.evil.example/mcp",
    "https://evil.example/mcp?target=https://gmailmcp.googleapis.com/mcp/v1",
    "not a URL containing gmailmcp.googleapis.com",
  ])("does not apply Google scopes to an untrusted URL: %s", (url) => {
    expect(inferGoogleOAuthScope(url)).toBe("");
  });
});

describe("OAuth server actions", () => {
  it("offers reconnect for a connected OAuth server", () => {
    const server = { authType: "oauth" as const, oauthConnected: true };
    expect(oauthConnectLabel(server)).toBe("Reconnect");
    expect(canRediscoverMcpServer(server)).toBe(true);
  });

  it("offers connect but not rediscovery before OAuth is connected", () => {
    const server = { authType: "oauth" as const, oauthConnected: false };
    expect(oauthConnectLabel(server)).toBe("Connect");
    expect(canRediscoverMcpServer(server)).toBe(false);
  });

  it("keeps rediscovery but has no OAuth action for a bearer server", () => {
    const server = { authType: "bearer" as const, oauthConnected: false };
    expect(oauthConnectLabel(server)).toBeNull();
    expect(canRediscoverMcpServer(server)).toBe(true);
  });
});

describe("Google OAuth endpoint constants", () => {
  it("are both HTTPS URLs", () => {
    expect(GOOGLE_OAUTH_AUTHORIZATION_ENDPOINT.startsWith("https://")).toBe(true);
    expect(GOOGLE_OAUTH_TOKEN_ENDPOINT.startsWith("https://")).toBe(true);
  });
});
