// backend/src/tools/mcp-oauth.ts
//
// OAuth 2.0 authorization-code protocol helpers for MCP servers that
// require OAuth instead of a static bearer token — see
// docs/adr/0002-external-tools-via-mcp-adapters.md. Pure protocol plus
// SSRF-hardened transport; no DB access — mcp-server-repo.ts owns
// persisting whatever these functions return.
import { randomBytes } from "node:crypto";
import { assertRemoteMcpDestination } from "./mcp-url.js";
import { pinnedDispatcher, readBoundedText, McpClientError } from "./mcp-client.js";

export type McpOAuthErrorCategory = "unsafe_destination" | "unreachable" | "remote_http" | "invalid_response";

export class McpOAuthError extends Error {
  constructor(
    readonly category: McpOAuthErrorCategory,
    readonly cause?: unknown,
  ) {
    super(`MCP OAuth error: ${category}`);
    this.name = "McpOAuthError";
  }
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(params: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  // Google-specific, but harmless for a spec-compliant OAuth 2.0 server
  // that ignores unknown query params: `access_type=offline` +
  // `prompt=consent` are what makes Google actually issue a refresh token
  // (matching the retired google-oauth-setup.ts script's behavior).
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- parses an OAuth token endpoint's untyped JSON response at its own boundary.
async function postToken(tokenEndpoint: string, body: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  let url: URL;
  let pinnedAddress: { host: string; family: 4 | 6 } | null;
  try {
    ({ url, address: pinnedAddress } = await assertRemoteMcpDestination(tokenEndpoint, undefined, requestSignal));
  } catch (error) {
    if (requestSignal.aborted) {
      throw new McpOAuthError("unreachable", error);
    }
    throw new McpOAuthError("unsafe_destination", error);
  }
  const dispatcher = pinnedAddress ? pinnedDispatcher(pinnedAddress) : undefined;
  const dispatcherAsUnknown: unknown = dispatcher;
  // SAFETY: same @types/node vs. undici Dispatcher type mismatch mcp-
  // client.ts's post() documents — both describe the same runtime contract.
  const fetchDispatcher = dispatcherAsUnknown as RequestInit["dispatcher"];
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      redirect: "manual",
      signal: requestSignal,
      dispatcher: fetchDispatcher,
    });
  } catch (error) {
    await dispatcher?.close();
    throw new McpOAuthError("unreachable", error);
  }
  try {
    let text: string;
    try {
      text = await readBoundedText(response);
    } catch (error) {
      if (error instanceof McpClientError) {
        throw new McpOAuthError("invalid_response", error);
      }
      throw error;
    }
    if (!response.ok) throw new McpOAuthError("remote_http");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new McpOAuthError("invalid_response", error);
    }
    if (!parsed || typeof parsed !== "object") throw new McpOAuthError("invalid_response");
    return parsed;
  } finally {
    await dispatcher?.close();
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parses an OAuth token endpoint's untyped JSON response at its own boundary.
function toTokenResult(body: unknown): OAuthTokenResult {
  // SAFETY: postToken already checked `body` is a non-null object; the
  // individual field types are validated below before use.
  const record = body as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token.length === 0) {
    throw new McpOAuthError("invalid_response");
  }
  if (typeof record.expires_in !== "number" || !Number.isFinite(record.expires_in)) {
    throw new McpOAuthError("invalid_response");
  }
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    expiresInSeconds: record.expires_in,
  };
}

export async function exchangeAuthorizationCode(
  params: { tokenEndpoint: string; clientId: string; clientSecret: string; code: string; redirectUri: string },
  signal?: AbortSignal,
): Promise<OAuthTokenResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
  return toTokenResult(await postToken(params.tokenEndpoint, body, signal));
}

export async function refreshAccessToken(
  params: { tokenEndpoint: string; clientId: string; clientSecret: string; refreshToken: string },
  signal?: AbortSignal,
): Promise<OAuthTokenResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  return toTokenResult(await postToken(params.tokenEndpoint, body, signal));
}
