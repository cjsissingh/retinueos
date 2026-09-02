import { eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import {
  createMcpServer,
  startMcpServerOAuth,
  consumeMcpServerOAuthState,
  storeMcpServerOAuthTokens,
  resolveMcpServerConnection,
  getMcpServer,
} from "../src/tools/mcp-server-repo.js";
import * as mcpOauth from "../src/tools/mcp-oauth.js";
import { McpClientError } from "../src/tools/mcp-client.js";

const { db } = useTestDb();

beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeOAuthServer() {
  return createMcpServer(db(), {
    name: "OAuth server",
    url: "https://93.184.216.34/mcp",
    authType: "oauth",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    oauthAuthorizationEndpoint: "https://93.184.216.34/authorize",
    oauthTokenEndpoint: "https://93.184.216.34/token",
    oauthScope: "scope-a",
  });
}

describe("startMcpServerOAuth", () => {
  it("stores a pending state and returns an authorize URL containing it", async () => {
    const server = await makeOAuthServer();
    const { authorizeUrl } = await startMcpServerOAuth(db(), server.id, "https://api.example.com/oauth/callback");

    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://93.184.216.34/authorize");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();

    const stored = await getMcpServer(db(), server.id);
    expect(stored?.oauthPendingState).toBe(state);
    expect(stored?.oauthPendingStateExpiresAt).toBeInstanceOf(Date);
  });

  it("throws for a bearer-authType server", async () => {
    const server = await createMcpServer(db(), { name: "Bearer", url: "https://93.184.216.34/mcp" });
    await expect(startMcpServerOAuth(db(), server.id, "https://api.example.com/oauth/callback")).rejects.toThrow();
  });
});

describe("consumeMcpServerOAuthState", () => {
  it("returns the server and clears the state on a valid match", async () => {
    const server = await makeOAuthServer();
    await startMcpServerOAuth(db(), server.id, "https://api.example.com/oauth/callback");
    const pending = await getMcpServer(db(), server.id);
    const state = pending!.oauthPendingState!;

    const consumed = await consumeMcpServerOAuthState(db(), state);
    expect(consumed?.id).toBe(server.id);

    const after = await getMcpServer(db(), server.id);
    expect(after?.oauthPendingState).toBeNull();
  });

  it("is single-use — a second consume of the same state returns undefined", async () => {
    const server = await makeOAuthServer();
    await startMcpServerOAuth(db(), server.id, "https://api.example.com/oauth/callback");
    const pending = await getMcpServer(db(), server.id);
    const state = pending!.oauthPendingState!;

    await consumeMcpServerOAuthState(db(), state);
    const second = await consumeMcpServerOAuthState(db(), state);
    expect(second).toBeUndefined();
  });

  it("returns undefined for an unknown state", async () => {
    expect(await consumeMcpServerOAuthState(db(), "not-a-real-state")).toBeUndefined();
  });

  it("returns undefined for an expired state", async () => {
    const server = await makeOAuthServer();
    await startMcpServerOAuth(db(), server.id, "https://api.example.com/oauth/callback");
    const pending = await getMcpServer(db(), server.id);
    const state = pending!.oauthPendingState!;
    // Directly backdate the expiry past "now" to simulate a stale link.
    await db()
      .update((await import("../src/db/schema.js")).mcpServers)
      .set({ oauthPendingStateExpiresAt: new Date(Date.now() - 1000) });

    expect(await consumeMcpServerOAuthState(db(), state)).toBeUndefined();
  });
});

describe("resolveMcpServerConnection", () => {
  it("returns the cached access token without a network call when it's still fresh", async () => {
    const server = await makeOAuthServer();
    await storeMcpServerOAuthTokens(db(), server.id, {
      accessToken: "fresh-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 3600,
    });
    const refreshSpy = vi.spyOn(mcpOauth, "refreshAccessToken");

    const connection = await resolveMcpServerConnection(db(), server.id);

    expect(connection).toEqual({ url: server.url, bearerToken: "fresh-token" });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("refreshes and persists a new access token when the cached one is near/past expiry", async () => {
    const server = await makeOAuthServer();
    await storeMcpServerOAuthTokens(db(), server.id, {
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 30, // inside the 60s refresh buffer
    });
    vi.spyOn(mcpOauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "new-token",
      expiresInSeconds: 3600,
    });

    const connection = await resolveMcpServerConnection(db(), server.id);

    expect(connection).toEqual({ url: server.url, bearerToken: "new-token" });
    const stored = await getMcpServer(db(), server.id);
    expect(stored?.oauthAccessToken).not.toBeNull();
    // The old refresh token is preserved since the refresh response omitted one.
    expect(stored?.oauthRefreshToken).not.toBeNull();
  });

  it("categorizes a failed refresh as requiring OAuth reauthorization without clearing the refresh token", async () => {
    const server = await makeOAuthServer();
    await storeMcpServerOAuthTokens(db(), server.id, {
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 30,
    });
    vi.spyOn(mcpOauth, "refreshAccessToken").mockRejectedValue(new mcpOauth.McpOAuthError("remote_http"));

    await expect(resolveMcpServerConnection(db(), server.id)).rejects.toMatchObject({
      name: McpClientError.name,
      category: "oauth_reauth_required",
    });
    expect((await getMcpServer(db(), server.id))?.oauthRefreshToken).not.toBeNull();
  });

  it("preserves an aborted refresh instead of misclassifying cancellation as reauthorization", async () => {
    const server = await makeOAuthServer();
    await storeMcpServerOAuthTokens(db(), server.id, {
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 30,
    });
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(mcpOauth, "refreshAccessToken").mockRejectedValue(new mcpOauth.McpOAuthError("unreachable"));

    await expect(resolveMcpServerConnection(db(), server.id, controller.signal)).rejects.toMatchObject({
      category: "unreachable",
    });
  });

  it("throws when the server has never completed the OAuth handshake", async () => {
    const server = await makeOAuthServer();
    await expect(resolveMcpServerConnection(db(), server.id)).rejects.toThrow(/has not completed the OAuth handshake/);
  });

  it("throws a distinct, field-naming message when a handshaked server's OAuth config is missing/corrupted", async () => {
    const server = await makeOAuthServer();
    await storeMcpServerOAuthTokens(db(), server.id, {
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 30, // inside the 60s refresh buffer, would otherwise trigger a refresh
    });
    const { mcpServers } = await import("../src/db/schema.js");
    await db().update(mcpServers).set({ oauthClientSecret: null }).where(eq(mcpServers.id, server.id));

    await expect(resolveMcpServerConnection(db(), server.id)).rejects.toThrow(
      /missing OAuth configuration \(oauthTokenEndpoint\/oauthClientId\/oauthClientSecret\) despite having completed the handshake/,
    );
  });
});
