import { describe, it, expect, afterEach, vi } from "vitest";
import {
  generateOAuthState,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  McpOAuthError,
} from "../src/tools/mcp-oauth.js";
import { McpClientError } from "../src/tools/mcp-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateOAuthState", () => {
  it("returns a distinct, non-empty token on every call", () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes every required OAuth param", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientId: "client-123",
        redirectUri: "https://api.example.com/oauth/callback",
        scope: "scope-a scope-b",
        state: "state-token",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("scope-a scope-b");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

// oxlint-disable-next-line anti-slop/no-unknown-returns -- test helper that returns untyped OAuth response
function stubTokenEndpoint(handler: (body: URLSearchParams) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as string);
      return new Response(JSON.stringify(handler(body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("exchangeAuthorizationCode", () => {
  it("always supplies a timeout signal to the token endpoint", async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestSignal = init.signal;
        return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await exchangeAuthorizationCode({
      tokenEndpoint: "https://93.184.216.34/token",
      clientId: "client-123",
      clientSecret: "secret-123",
      code: "auth-code",
      redirectUri: "https://api.example.com/oauth/callback",
    });

    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });

  it("posts the authorization_code grant and returns the parsed tokens", async () => {
    let seenBody: URLSearchParams | undefined;
    stubTokenEndpoint((body) => {
      seenBody = body;
      return { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 };
    });

    const result = await exchangeAuthorizationCode({
      tokenEndpoint: "https://93.184.216.34/token",
      clientId: "client-123",
      clientSecret: "secret-123",
      code: "auth-code",
      redirectUri: "https://api.example.com/oauth/callback",
    });

    expect(result).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresInSeconds: 3600 });
    expect(seenBody?.get("grant_type")).toBe("authorization_code");
    expect(seenBody?.get("code")).toBe("auth-code");
    expect(seenBody?.get("client_id")).toBe("client-123");
    expect(seenBody?.get("client_secret")).toBe("secret-123");
    expect(seenBody?.get("redirect_uri")).toBe("https://api.example.com/oauth/callback");
  });

  it("leaves refreshToken undefined when the response omits it", async () => {
    stubTokenEndpoint(() => ({ access_token: "at-1", expires_in: 3600 }));

    const result = await exchangeAuthorizationCode({
      tokenEndpoint: "https://93.184.216.34/token",
      clientId: "c",
      clientSecret: "s",
      code: "code",
      redirectUri: "https://api.example.com/oauth/callback",
    });

    expect(result.refreshToken).toBeUndefined();
  });

  it("rejects a token endpoint that resolves to a private address", async () => {
    stubTokenEndpoint(() => ({ access_token: "at-1", expires_in: 3600 }));

    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: "https://127.0.0.1/token",
        clientId: "c",
        clientSecret: "s",
        code: "code",
        redirectUri: "https://api.example.com/oauth/callback",
      }),
    ).rejects.toThrow(McpOAuthError);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );

    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: "https://93.184.216.34/token",
        clientId: "c",
        clientSecret: "s",
        code: "code",
        redirectUri: "https://api.example.com/oauth/callback",
      }),
    ).rejects.toThrow(McpOAuthError);
  });

  it("throws on a response missing access_token", async () => {
    stubTokenEndpoint(() => ({ expires_in: 3600 }));

    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: "https://93.184.216.34/token",
        clientId: "c",
        clientSecret: "s",
        code: "code",
        redirectUri: "https://api.example.com/oauth/callback",
      }),
    ).rejects.toThrow(McpOAuthError);
  });

  it("wraps readBoundedText McpClientError as McpOAuthError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(10000), { status: 200 })),
    );

    // Mock readBoundedText to throw McpClientError
    vi.spyOn(await import("../src/tools/mcp-client.js"), "readBoundedText").mockRejectedValueOnce(
      new McpClientError("response_too_large"),
    );

    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: "https://93.184.216.34/token",
        clientId: "c",
        clientSecret: "s",
        code: "code",
        redirectUri: "https://api.example.com/oauth/callback",
      }),
    ).rejects.toThrow(McpOAuthError);
  });

  it("throws unreachable on aborted signal, not unsafe_destination", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      exchangeAuthorizationCode(
        {
          tokenEndpoint: "https://93.184.216.34/token",
          clientId: "c",
          clientSecret: "s",
          code: "code",
          redirectUri: "https://api.example.com/oauth/callback",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ category: "unreachable" });
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh_token grant and returns the parsed tokens", async () => {
    let seenBody: URLSearchParams | undefined;
    stubTokenEndpoint((body) => {
      seenBody = body;
      return { access_token: "at-2", expires_in: 1800 };
    });

    const result = await refreshAccessToken({
      tokenEndpoint: "https://93.184.216.34/token",
      clientId: "client-123",
      clientSecret: "secret-123",
      refreshToken: "rt-1",
    });

    expect(result).toEqual({ accessToken: "at-2", refreshToken: undefined, expiresInSeconds: 1800 });
    expect(seenBody?.get("grant_type")).toBe("refresh_token");
    expect(seenBody?.get("refresh_token")).toBe("rt-1");
  });
});
