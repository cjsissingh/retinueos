import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { mcpRoutes } from "../src/tools/mcp-routes.js";
import { defaultRegistry } from "../src/tools/registry.js";

const { db } = useTestDb();

beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubMcpServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      // SAFETY: this fixture only ever receives the request bodies
      // mcp-client.ts's own rpcCall constructs — a controlled test double,
      // not untrusted external input.
      const body = JSON.parse(init.body as string) as { id: number; method: string };
      const results = {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
        "tools/list": {
          tools: [
            {
              name: "safe_read",
              description: "read",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        },
        "tools/call": { status: "ok" },
      } satisfies Record<string, unknown>;
      // SAFETY: every test in this file only ever drives the three RPC
      // methods mcp-client.ts issues (initialize, tools/list, tools/call),
      // all present in `results` above.
      const result = results[body.method as keyof typeof results];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function stubOAuthProvider(opts?: { onExchange?: (body: URLSearchParams) => void }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const target = new URL(url);
      if (target.pathname === "/token") {
        const body = new URLSearchParams(init.body as string);
        opts?.onExchange?.(body);
        return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // MCP JSON-RPC endpoint — same fixture shape as stubMcpServer above.
      const body = JSON.parse(init.body as string) as { id: number; method: string };
      const results = {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        },
        "tools/list": { tools: [{ name: "safe_read", description: "read", inputSchema: { type: "object" } }] },
      } satisfies Record<string, unknown>;
      const result = results[body.method as keyof typeof results];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function createOAuthServer(app: Hono) {
  const res = await app.request("/mcp/servers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authType: "oauth",
      name: "Gmail",
      url: "https://93.184.216.34/mcp",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthAuthorizationEndpoint: "https://93.184.216.34/authorize",
      oauthTokenEndpoint: "https://93.184.216.34/token",
      oauthScope: "scope-a",
    }),
  });
  return (await res.json()).server;
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", mcpRoutes(db()));
  return app;
}

describe("mcp routes", () => {
  it("POST /mcp/servers accepts a globally routable IPv6 literal", async () => {
    stubMcpServer();
    const res = await buildApp().request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "IPv6", url: "https://[2606:4700:4700::1111]/mcp" }),
    });

    expect(res.status).toBe(201);
  });

  it("POST /mcp/servers permits a non-default HTTPS port", async () => {
    stubMcpServer();
    const res = await buildApp().request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Custom TLS port", url: "https://93.184.216.34:8443/mcp" }),
    });

    expect(res.status).toBe(201);
  });

  it.each([
    "http://public.example/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://10.0.0.8/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://192.0.2.1/mcp",
    "https://198.51.100.1/mcp",
    "https://203.0.113.1/mcp",
    "https://[::ffff:7f00:1]/mcp",
    "https://public.example/mcp#fragment",
    "https://user:password@public.example/mcp",
  ])("POST /mcp/servers rejects non-remote URL %s before storing it", async (url) => {
    stubMcpServer();
    const app = buildApp();
    const res = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Unsafe", url }),
    });

    expect(res.status).toBe(400);
  });

  it("POST /mcp/servers creates a server and discovers its tools", async () => {
    stubMcpServer();
    const app = buildApp();
    const res = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.server.name).toBe("Fake");
    expect(body.server).not.toHaveProperty("bearerToken");
    expect(body.discovery).toEqual({ ok: true, toolCount: 1 });
  });

  it("GET /mcp/servers never exposes encrypted bearer tokens", async () => {
    stubMcpServer();
    const app = buildApp();
    await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Token server", url: "https://93.184.216.34/mcp", bearerToken: "secret" }),
    });

    const res = await app.request("/mcp/servers");
    const servers = await res.json();
    const server = servers.find((candidate: { name: string }) => candidate.name === "Token server");
    expect(server).not.toHaveProperty("bearerToken");
  });

  it("POST /mcp/servers still creates the server row when discovery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const app = buildApp();
    const res = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Unreachable", url: "https://93.184.216.34/mcp" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.server.name).toBe("Unreachable");
    expect(body.discovery.ok).toBe(false);
  });

  it("returns a safe HTTP failure category and status without remote or credential text", async () => {
    const bearerToken = "top-secret-bearer";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`remote leaked ${bearerToken}`, { status: 502 })),
    );

    const res = await buildApp().request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Hostile error server",
        url: "https://93.184.216.34/mcp",
        bearerToken,
      }),
    });
    const body = await res.json();

    expect(body.discovery).toMatchObject({ ok: false, errorCategory: "remote_http", remoteStatus: 502 });
    expect(JSON.stringify(body)).not.toContain(bearerToken);
    expect(JSON.stringify(body)).not.toContain("remote leaked");
  });

  it("does not echo a remote JSON-RPC error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as { id: number };
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "remote secret" } }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res = await buildApp().request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "RPC error server", url: "https://93.184.216.34/mcp" }),
    });
    const body = await res.json();

    expect(body.discovery).toMatchObject({ ok: false, errorCategory: "invalid_response" });
    expect(JSON.stringify(body)).not.toContain("remote secret");
  });

  it("PATCH .../tools/:toolId rejects approved: true without a riskClass", async () => {
    stubMcpServer();
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();
    const toolsRes = await app.request(`/mcp/servers/${server.id}/tools`);
    const [tool] = await toolsRes.json();

    const patchRes = await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(patchRes.status).toBe(400);
  });

  it("PATCH .../tools/:toolId approves and registers the tool into defaultRegistry", async () => {
    stubMcpServer();
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();
    const toolsRes = await app.request(`/mcp/servers/${server.id}/tools`);
    const [tool] = await toolsRes.json();

    const patchRes = await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskClass: "read_only", approved: true }),
    });
    expect(patchRes.status).toBe(200);
    const id = `mcp:${server.id}:safe_read`;
    expect(defaultRegistry.has(id)).toBe(true);
    defaultRegistry.unregister(id);
  });

  it("GET /mcp/tools exposes only human-approved tools for persona assignment", async () => {
    stubMcpServer();
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();
    const toolsRes = await app.request(`/mcp/servers/${server.id}/tools`);
    const [tool] = await toolsRes.json();

    expect(await (await app.request("/mcp/tools")).json()).toEqual([]);

    await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskClass: "read_only", approved: true }),
    });

    expect(await (await app.request("/mcp/tools")).json()).toEqual([
      {
        id: `mcp:${server.id}:safe_read`,
        label: "safe_read",
        sourceName: "Fake",
        riskClass: "read_only",
      },
    ]);
    defaultRegistry.unregister(`mcp:${server.id}:safe_read`);
  });

  it("disabling a server removes its approved tools from the live registry and assignment catalog", async () => {
    stubMcpServer();
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();
    const [tool] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();
    await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskClass: "read_only", approved: true }),
    });
    const toolId = `mcp:${server.id}:safe_read`;
    expect(defaultRegistry.has(toolId)).toBe(true);

    const disableRes = await app.request(`/mcp/servers/${server.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(disableRes.status).toBe(200);
    expect(defaultRegistry.has(toolId)).toBe(false);
    expect(await (await app.request("/mcp/tools")).json()).toEqual([]);
  });

  it("PATCH /mcp/servers/:id rotates the bearer token in place without deleting tool approvals", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        requests.push(headers.get("authorization") ?? "");
        const body = JSON.parse(init.body as string) as { id: number; method: string };
        const results = {
          initialize: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
          "tools/list": {
            tools: [{ name: "safe_read", description: "read", inputSchema: { type: "object" } }],
          },
          "tools/call": { status: "ok" },
        } satisfies Record<string, unknown>;
        const result = results[body.method as keyof typeof results];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rotates", url: "https://93.184.216.34/mcp", bearerToken: "old-token" }),
    });
    const { server } = await createRes.json();
    const [tool] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();
    await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskClass: "read_only", approved: true }),
    });
    const registryId = `mcp:${server.id}:safe_read`;
    expect(defaultRegistry.has(registryId)).toBe(true);

    const patchRes = await app.request(`/mcp/servers/${server.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bearerToken: "new-token" }),
    });
    expect(patchRes.status).toBe(200);

    // Approval survives a credential rotation — no DELETE cascade involved.
    const [toolAfterRotation] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();
    expect(toolAfterRotation).toMatchObject({ approved: true, riskClass: "read_only" });
    expect(defaultRegistry.has(registryId)).toBe(true);

    // The live registration now calls the server with the rotated token.
    await defaultRegistry.get(registryId).run({});
    expect(requests.at(-1)).toBe("Bearer new-token");
    defaultRegistry.unregister(registryId);
  });

  it("rediscovery unregisters and revokes a tool whose schema content changed", async () => {
    let description = "read v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(init.body as string) as { id?: number; method: string };
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          request.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : { tools: [{ name: "safe_read", description, inputSchema: { type: "object" } }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mutable", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();
    const [tool] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();
    await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskClass: "read_only", approved: true }),
    });
    const registryId = `mcp:${server.id}:safe_read`;
    expect(defaultRegistry.has(registryId)).toBe(true);

    description = "read v2";
    const rediscoverRes = await app.request(`/mcp/servers/${server.id}/discover`, { method: "POST" });
    const [changed] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();

    expect(rediscoverRes.status).toBe(200);
    expect(changed).toMatchObject({ approved: false, riskClass: null });
    expect(defaultRegistry.has(registryId)).toBe(false);
  });

  it("DELETE /mcp/servers/:id removes the server and its tools", async () => {
    stubMcpServer();
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();

    const delRes = await app.request(`/mcp/servers/${server.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    const listRes = await app.request("/mcp/servers");
    const servers = await listRes.json();
    expect(servers.find((s: { id: string }) => s.id === server.id)).toBeUndefined();
  });

  it("POST /mcp/servers sends plaintext bearer token to MCP server, not ciphertext", async () => {
    const plaintextToken = "secret-token-1234";
    let capturedAuthHeader: string | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        // Capture the Authorization header sent to the MCP server during initialize call
        // The mcp-client.ts sets headers using Headers object, so we need to check it properly
        if (init.headers instanceof Headers) {
          capturedAuthHeader = init.headers.get("authorization") || undefined;
        } else if (typeof init.headers === "object" && init.headers !== null) {
          const headers = init.headers as Record<string, string>;
          capturedAuthHeader = headers.authorization;
        }

        const body = JSON.parse(init.body as string) as { id: number; method: string };
        const results = {
          initialize: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
          "tools/list": {
            tools: [
              {
                name: "test_tool",
                description: "test",
                inputSchema: { type: "object" },
              },
            ],
          },
        } satisfies Record<string, unknown>;
        const result = results[body.method as keyof typeof results];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bearer Server",
        url: "https://93.184.216.34/mcp",
        bearerToken: plaintextToken,
      }),
    });

    expect(createRes.status).toBe(201);
    // The Authorization header should be "Bearer <plaintext>", NOT the encrypted ciphertext
    expect(capturedAuthHeader).toBe(`Bearer ${plaintextToken}`);
  });
});

describe("mcp oauth routes", () => {
  it("POST /mcp/servers with authType oauth creates the row without attempting discovery", async () => {
    stubOAuthProvider();
    const app = buildApp();
    const res = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authType: "oauth",
        name: "Gmail",
        url: "https://93.184.216.34/mcp",
        oauthClientId: "client-id",
        oauthClientSecret: "client-secret",
        oauthAuthorizationEndpoint: "https://93.184.216.34/authorize",
        oauthTokenEndpoint: "https://93.184.216.34/token",
        oauthScope: "scope-a",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.server.authType).toBe("oauth");
    expect(body.server).not.toHaveProperty("oauthClientSecret");
    expect(body.discovery).toEqual({ ok: false, errorCategory: "not_connected" });
  });

  it("POST /mcp/servers/:id/oauth/start returns an authorize URL for an oauth server", async () => {
    stubOAuthProvider();
    const app = buildApp();
    const server = await createOAuthServer(app);

    const res = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const { authorizeUrl } = await res.json();
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("client-id");
  });

  it("POST .../oauth/start rejects a bearer-authType server", async () => {
    stubMcpServer();
    const app = buildApp();
    const createRes = await app.request("/mcp/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fake", url: "https://93.184.216.34/mcp" }),
    });
    const { server } = await createRes.json();

    const res = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("GET /oauth/callback completes the handshake, discovers tools, and redirects with connected=<id>", async () => {
    let exchangeBody: URLSearchParams | undefined;
    stubOAuthProvider({ onExchange: (body) => (exchangeBody = body) });
    const app = buildApp();
    const server = await createOAuthServer(app);
    const startRes = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    const { authorizeUrl } = await startRes.json();
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const res = await app.request(`/oauth/callback?code=auth-code&state=${state}`, { redirect: "manual" });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/settings/mcp");
    expect(location.searchParams.get("connected")).toBe(server.id);
    expect(exchangeBody?.get("code")).toBe("auth-code");

    const toolsRes = await app.request(`/mcp/servers/${server.id}/tools`);
    expect(await toolsRes.json()).toHaveLength(1);
  });

  it("POST .../discover resolves the stored OAuth access token", async () => {
    const mcpAuthorizationHeaders: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const target = new URL(url);
        if (target.pathname === "/token") {
          return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        mcpAuthorizationHeaders.push(new Headers(init.headers).get("authorization"));
        const body = JSON.parse(init.body as string) as { id: number; method: string };
        const results = {
          initialize: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
          "tools/list": { tools: [{ name: "safe_read", description: "read", inputSchema: { type: "object" } }] },
        } satisfies Record<string, unknown>;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: results[body.method as keyof typeof results] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const app = buildApp();
    const server = await createOAuthServer(app);
    const startRes = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    const state = new URL((await startRes.json()).authorizeUrl).searchParams.get("state")!;
    await app.request(`/oauth/callback?code=auth-code&state=${state}`, { redirect: "manual" });
    mcpAuthorizationHeaders.length = 0;

    const res = await app.request(`/mcp/servers/${server.id}/discover`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(mcpAuthorizationHeaders).not.toHaveLength(0);
    expect(mcpAuthorizationHeaders.every((header) => header === "Bearer at-1")).toBe(true);
  });

  it("OAuth reconnect discovery removes a live tool whose contract changed", async () => {
    let description = "read v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (new URL(url).pathname === "/token") {
          return new Response(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const body = JSON.parse(init.body as string) as { id: number; method: string };
        const results = {
          initialize: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
          "tools/list": { tools: [{ name: "safe_read", description, inputSchema: { type: "object" } }] },
        } satisfies Record<string, unknown>;
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: results[body.method as keyof typeof results] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const app = buildApp();
    const server = await createOAuthServer(app);
    const firstStart = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    const firstState = new URL((await firstStart.json()).authorizeUrl).searchParams.get("state")!;
    await app.request(`/oauth/callback?code=first&state=${firstState}`, { redirect: "manual" });
    const [tool] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();
    await app.request(`/mcp/servers/${server.id}/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ riskClass: "read_only", approved: true }),
    });
    const registryId = `mcp:${server.id}:safe_read`;
    expect(defaultRegistry.has(registryId)).toBe(true);

    description = "read v2";
    const secondStart = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    const secondState = new URL((await secondStart.json()).authorizeUrl).searchParams.get("state")!;
    await app.request(`/oauth/callback?code=second&state=${secondState}`, { redirect: "manual" });
    const [changed] = await (await app.request(`/mcp/servers/${server.id}/tools`)).json();
    const remainedRegistered = defaultRegistry.has(registryId);
    defaultRegistry.unregister(registryId);

    expect(changed).toMatchObject({ approved: false, riskClass: null });
    expect(remainedRegistered).toBe(false);
  });

  it("GET /oauth/callback redirects with oauth_error=invalid_state for an unknown state", async () => {
    const app = buildApp();
    const res = await app.request("/oauth/callback?code=x&state=unknown", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("oauth_error")).toBe("invalid_state");
  });

  it("GET /oauth/callback redirects with oauth_error=invalid_state when code is missing", async () => {
    const app = buildApp();
    const res = await app.request("/oauth/callback?state=whatever", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("oauth_error")).toBe("invalid_state");
  });

  it("GET /oauth/callback redirects with oauth_error=token_exchange_failed when the token endpoint rejects the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 400 })),
    );
    const app = buildApp();
    // Create the server + pending state directly against the repo, since
    // the stubbed fetch above can't also serve discovery for creation.
    const { createMcpServer, startMcpServerOAuth } = await import("../src/tools/mcp-server-repo.js");
    const server = await createMcpServer(db(), {
      name: "Gmail",
      url: "https://93.184.216.34/mcp",
      authType: "oauth",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthAuthorizationEndpoint: "https://93.184.216.34/authorize",
      oauthTokenEndpoint: "https://93.184.216.34/token",
      oauthScope: "scope-a",
    });
    const { authorizeUrl } = await startMcpServerOAuth(db(), server.id, "https://api.example.com/oauth/callback");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const res = await app.request(`/oauth/callback?code=auth-code&state=${state}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("oauth_error")).toBe("token_exchange_failed");
  });

  it("GET /oauth/callback redirects with oauth_error=invalid_state when the state lookup itself fails", async () => {
    const app = buildApp();
    const database = db();
    // Simulates a transient DB failure on the very first write the handler
    // makes (consumeMcpServerOAuthState's UPDATE...RETURNING) — a state
    // that could be perfectly valid, but the lookup itself blew up. There's
    // no app.onError fallback in app.ts, so without the route's own
    // try/catch this would propagate uncaught and Hono would return a raw
    // 500 instead of the documented redirect-with-oauth_error contract.
    vi.spyOn(database, "update").mockImplementationOnce(() => {
      throw new Error("db exploded");
    });

    const res = await app.request("/oauth/callback?code=x&state=whatever", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("oauth_error")).toBe("invalid_state");
  });

  it("GET /oauth/callback redirects with oauth_error=storage_failed when persisting the tokens fails", async () => {
    stubOAuthProvider();
    const app = buildApp();
    const server = await createOAuthServer(app);
    const startRes = await app.request(`/mcp/servers/${server.id}/oauth/start`, { method: "POST" });
    const { authorizeUrl } = await startRes.json();
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const database = db();
    const originalUpdate = database.update.bind(database);
    let updateCalls = 0;
    // The handler's first db.update call (inside consumeMcpServerOAuthState)
    // must succeed normally so execution reaches the token exchange and
    // then storeMcpServerOAuthTokens's own db.update — only that second
    // call is made to fail, isolating "the token exchange succeeded but
    // retinueos's own DB write failed" from "the state lookup failed".
    vi.spyOn(database, "update").mockImplementation((...args: Parameters<typeof database.update>) => {
      updateCalls += 1;
      if (updateCalls === 2) throw new Error("db exploded");
      return originalUpdate(...args);
    });

    const res = await app.request(`/oauth/callback?code=auth-code&state=${state}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("oauth_error")).toBe("storage_failed");
  });

  it("GET /oauth/callback is reachable without X-Auth-Password", async () => {
    // No auth header on any request in this file's oauth tests above —
    // this test just makes that constraint explicit and named.
    const app = buildApp();
    const res = await app.request("/oauth/callback?code=x&state=unknown", { redirect: "manual" });
    expect(res.status).not.toBe(401);
  });
});
