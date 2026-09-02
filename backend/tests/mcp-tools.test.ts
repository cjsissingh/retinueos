import { createServer, type Server } from "node:http";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { discoverTools, callMcpTool, pinnedDispatcher } from "../src/tools/mcp-client.js";
import { assertRemoteMcpDestination } from "../src/tools/mcp-url.js";
import {
  createMcpServer,
  upsertDiscoveredTools,
  listMcpServerTools,
  setMcpServerToolApproval,
  deleteMcpServer,
} from "../src/tools/mcp-server-repo.js";
import { registerApprovedMcpTool, unregisterMcpServer, mcpToolId } from "../src/tools/mcp-registration.js";
import { ToolRegistry } from "../src/tools/registry.js";

const { db } = useTestDb();

// Hoisted to module scope (not inline in its one test below) -- it closes
// over nothing, so a fresh closure per test run buys nothing over a single
// shared function.
async function slowFixedAddressResolver(): Promise<Array<{ address: string; family: number }>> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return [{ address: "8.8.8.8", family: 4 }];
}

beforeAll(() => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

// A fake MCP server's JSON-RPC responses, keyed by method — mirrors this
// backend's vi.stubGlobal("fetch", ...) pattern used elsewhere for
// external-HTTP-call tests (frontend/tests/api-client.test.ts's approach,
// adapted for node/vitest here since no backend precedent for mocking an
// outbound HTTP call to an external server existed to match).
interface McpRpcRequestBody {
  id: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string };
}
type McpHandlerResult = Record<string, unknown>;

const privateResolver = async () => [{ address: "127.0.0.1", family: 4 }];
const validInitializeResult = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture", version: "1.0.0" },
};

function stubMcpServer(handlers: Record<string, (params: McpRpcRequestBody["params"]) => McpHandlerResult>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      // SAFETY: this fixture only ever receives the request bodies
      // mcp-client.ts's own rpcCall constructs (see its `{ jsonrpc, id,
      // method, params }` literal) — a controlled test double, not
      // untrusted external input.
      const body = JSON.parse(init.body as string) as McpRpcRequestBody;
      const handler = handlers[body.method];
      if (!handler) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no handler" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const result = handler(body.params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mcp-client", () => {
  it.each([
    "192.0.0.8",
    "192.88.99.1",
    "100::1",
    "fec0::1",
    "3fff::1",
    "5f00::1",
    "2001:2::1",
    "2001:5::1",
    "2001:10::1",
    "2002:c000:0201::1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "::ffff:192.0.0.8",
    "::ffff:0:127.0.0.1",
  ])("rejects IANA special-purpose DNS result %s", async (address) => {
    const resolver = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
    await expect(assertRemoteMcpDestination("https://fixture.example/rpc", resolver)).rejects.toThrow(
      /private|non-routable/i,
    );
  });

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:1::1",
    "2001:1::2",
    "2001:1::3",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
  ])("allows global-unicast DNS result %s", async (address) => {
    const resolver = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
    const result = await assertRemoteMcpDestination("https://fixture.example/rpc", resolver);
    expect(result.url).toBeInstanceOf(URL);
    expect(result.address).toMatchObject({ host: address });
  });

  it("rejects a public hostname when DNS resolves it to a private address", async () => {
    await expect(assertRemoteMcpDestination("https://fixture.example/rpc", privateResolver)).rejects.toThrow(
      /private|non-routable/i,
    );
  });

  it("pinnedDispatcher connects to the validated address, not a fresh resolution of the hostname", async () => {
    // Regression test for the DNS-rebinding SSRF bypass: assertRemoteMcpDestination
    // validates one resolved address, and the actual connection must use that
    // exact address rather than letting fetch/undici re-resolve the hostname
    // itself (which a hostile MCP server's authoritative DNS could answer
    // differently on a second lookup). "spoofed.example" here deliberately
    // resolves to nothing real -- if the dispatcher's lookup override weren't
    // actually being used, this request would fail to connect at all, not
    // silently succeed against the pinned loopback server.
    let observedHost: string | undefined;
    const server: Server = createServer((req, res) => {
      observedHost = req.headers.host;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const dispatcher = pinnedDispatcher({ host: "127.0.0.1", family: 4 });
      const res = await fetch(`http://spoofed.example:${port}/rpc`, { dispatcher });
      expect(res.status).toBe(200);
      expect(observedHost).toBe(`spoofed.example:${port}`);
      await dispatcher.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("aborts a stalled DNS preflight with the caller signal", async () => {
    const controller = new AbortController();
    let resolverSignal: AbortSignal | undefined;
    const resolver = async (_hostname: string, signal?: AbortSignal) => {
      resolverSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [{ address: "8.8.8.8", family: 4 }];
    };

    const pending = assertRemoteMcpDestination("https://fixture.example/rpc", resolver, controller.signal);
    controller.abort(new Error("job cancelled"));

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(resolverSignal).toBe(controller.signal);
  });

  it("aborts a stalled DNS preflight when its timeout signal expires", async () => {
    await expect(
      assertRemoteMcpDestination("https://fixture.example/rpc", slowFixedAddressResolver, AbortSignal.timeout(5)),
    ).rejects.toThrow(/abort|timeout/i);
  });

  it("completes the MCP initialization lifecycle and carries the session id", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        const headers = new Headers(init.headers);
        requests.push({ headers, body });
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1.0.0" },
              },
            }),
            { headers: { "content-type": "application/json", "mcp-session-id": "session-123" } },
          );
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await discoverTools({ url: "https://93.184.216.34/mcp" });

    expect(requests.map((request) => request.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(requests[1]?.body).not.toHaveProperty("id");
    expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[2]?.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("initializes a session before invoking a tool", async () => {
    const methods: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id?: number; method: string };
        methods.push(body.method);
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1.0.0" },
              }
            : { content: [{ type: "text", text: "ok" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await callMcpTool({ url: "https://93.184.216.34/mcp" }, "echo", {});

    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("selects the matching JSON-RPC response from an SSE stream", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id?: number; method: string };
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1.0.0" },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        const sse = [
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}`,
          "",
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}`,
          "",
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: 999999, result: { tools: [{ name: "wrong" }] } })}`,
          "",
        ].join("\n");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }),
    );

    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).resolves.toEqual([]);
  });

  it("discoverTools does the handshake and returns tools with hint annotations", async () => {
    stubMcpServer({
      initialize: () => validInitializeResult,
      "tools/list": () => ({
        tools: [
          {
            name: "read_file",
            description: "reads a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: "delete_file",
            description: "deletes a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            annotations: { destructiveHint: true },
          },
          { name: "write_file", description: "writes a file", inputSchema: { type: "object" } },
        ],
      }),
    });

    const tools = await discoverTools({ url: "https://93.184.216.34/mcp" });
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({ name: "read_file", readOnlyHint: true });
    expect(tools[1]).toMatchObject({ name: "delete_file", destructiveHint: true });
    expect(tools[2]).toMatchObject({ name: "write_file" });
  });

  it("throws a clear error when the server is unreachable, distinct from zero tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).rejects.toThrow(/couldn't reach/i);
  });

  it("callMcpTool posts a tools/call and returns the result content", async () => {
    stubMcpServer({
      initialize: () => validInitializeResult,
      "notifications/initialized": () => ({}),
      "tools/call": (params) => ({ echoed: params?.arguments ?? {} }),
    });
    const result = await callMcpTool({ url: "https://93.184.216.34/mcp" }, "echo", { hello: "world" });
    expect(result).toEqual({ echoed: { hello: "world" } });
  });

  it("follows every tools/list cursor page", async () => {
    const cursors: Array<string | undefined> = [];
    stubMcpServer({
      initialize: () => ({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      }),
      "tools/list": (params) => {
        cursors.push(params?.cursor);
        return params?.cursor === "second"
          ? { tools: [{ name: "two", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "one", inputSchema: { type: "object" } }], nextCursor: "second" };
      },
    });

    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).resolves.toEqual([
      expect.objectContaining({ name: "one" }),
      expect.objectContaining({ name: "two" }),
    ]);
    expect(cursors).toEqual([undefined, "second"]);
  });

  it("treats an empty-string nextCursor as an opaque cursor, not catalog completion", async () => {
    const cursors: Array<string | undefined> = [];
    stubMcpServer({
      initialize: () => validInitializeResult,
      "tools/list": (params) => {
        cursors.push(params?.cursor);
        return cursors.length === 1
          ? { tools: [{ name: "one", inputSchema: { type: "object" } }], nextCursor: "" }
          : { tools: [{ name: "two", inputSchema: { type: "object" } }] };
      },
    });

    const tools = await discoverTools({ url: "https://93.184.216.34/mcp" });
    expect(tools.map(({ name }) => name)).toEqual(["one", "two"]);
    expect(cursors).toEqual([undefined, ""]);
  });

  it("rejects a tools/list cursor loop", async () => {
    stubMcpServer({
      initialize: () => ({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      }),
      "tools/list": () => ({ tools: [], nextCursor: "same" }),
    });

    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).rejects.toThrow(/catalog|cursor|pagination/i);
  });

  it("caps a non-terminating tools/list pagination chain", async () => {
    let pages = 0;
    stubMcpServer({
      initialize: () => validInitializeResult,
      "tools/list": () => ({ tools: [], nextCursor: String(++pages) }),
    });

    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).rejects.toThrow(/catalog|pagination/i);
    expect(pages).toBe(100);
  });

  it("propagates caller cancellation through initialize, notification, and tool call requests", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal!);
        const body = JSON.parse(init.body as string) as McpRpcRequestBody;
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result =
          body.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : { content: [{ type: "text", text: "ok" }] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const controller = new AbortController();

    await callMcpTool({ url: "https://93.184.216.34/mcp" }, "echo", {}, controller.signal);
    controller.abort(new Error("job cancelled"));

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("throws when tools/call returns isError while retaining bounded detail", async () => {
    stubMcpServer({
      initialize: () => ({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      }),
      "tools/call": () => ({ isError: true, content: [{ type: "text", text: "not permitted" }] }),
    });

    await expect(callMcpTool({ url: "https://93.184.216.34/mcp" }, "echo", {})).rejects.toMatchObject({
      message: expect.stringMatching(/tool.*failure/i),
      externalOutcomeKnown: true,
      detail: expect.objectContaining({ content: expect.any(Array) }),
    });
  });

  it("stops reading a streamed response as soon as it exceeds 5 MiB", async () => {
    let request = 0;
    let chunksRead = 0;
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as McpRpcRequestBody;
        request += 1;
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (request === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            chunksRead += 1;
            if (chunksRead <= 8) controller.enqueue(new Uint8Array(1024 * 1024));
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      }),
    );

    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).rejects.toThrow(/oversized|large/i);
    expect(cancelled).toBe(true);
    expect(chunksRead).toBeLessThan(8);
  });

  it.each([
    {},
    { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } },
    { protocolVersion: "", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
  ])("rejects invalid initialize result %#", async (initializeResult) => {
    stubMcpServer({ initialize: () => initializeResult });
    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).rejects.toThrow(/protocol|capabilit|initialize/i);
  });

  it("accepts a spec-compliant server that negotiates a different protocolVersion, only warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMcpServer({
      initialize: () => ({
        protocolVersion: "2099-01-01",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      }),
      "tools/list": () => ({ tools: [] }),
    });
    await expect(discoverTools({ url: "https://93.184.216.34/mcp" })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/protocolVersion/i));
    warn.mockRestore();
  });
});

describe("mcp server + tool discovery/approval flow", () => {
  beforeEach(() => {
    stubMcpServer({
      initialize: () => validInitializeResult,
      "tools/list": () => ({
        tools: [
          {
            name: "safe_read",
            description: "read",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
          {
            name: "danger_op",
            description: "danger",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: true },
          },
          { name: "middle_op", description: "unclear", inputSchema: { type: "object" } },
        ],
      }),
      "tools/call": () => ({ status: "ok" }),
    });
  });

  it("discovery populates mcp_server_tools with hint-derived defaults and approved: false", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const descriptors = await discoverTools({ url: server.url });
    const rows = await upsertDiscoveredTools(db(), server.id, descriptors);
    expect(rows).toHaveLength(3);

    const safe = rows.find((r) => r.toolName === "safe_read")!;
    const danger = rows.find((r) => r.toolName === "danger_op")!;
    const middle = rows.find((r) => r.toolName === "middle_op")!;

    expect(safe.serverHintRiskClass).toBe("read_only");
    expect(danger.serverHintRiskClass).toBe("destructive");
    expect(middle.serverHintRiskClass).toBe("reversible");

    for (const row of rows) {
      expect(row.approved).toBe(false);
      expect(row.riskClass).toBeNull();
    }
  });

  it("re-discovery upserts instead of duplicating rows", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const first = await upsertDiscoveredTools(db(), server.id, await discoverTools({ url: server.url }));
    const second = await upsertDiscoveredTools(db(), server.id, await discoverTools({ url: server.url }));
    expect(second).toHaveLength(first.length);
    const allRows = await listMcpServerTools(db(), server.id);
    expect(allRows).toHaveLength(3);
  });

  it("keeps a stable version for unchanged discovery content", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const descriptor = { name: "read", description: "read v1", inputSchema: { type: "object" } };
    const [first] = await upsertDiscoveredTools(db(), server.id, [descriptor]);
    const [second] = await upsertDiscoveredTools(db(), server.id, [descriptor]);

    expect(first?.version).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.version).toBe(first?.version);
  });

  it("changes the version when a discovered description or schema changes", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const [first] = await upsertDiscoveredTools(db(), server.id, [
      { name: "read", description: "read v1", inputSchema: { type: "object" } },
    ]);
    const [descriptionChanged] = await upsertDiscoveredTools(db(), server.id, [
      { name: "read", description: "read v2", inputSchema: { type: "object" } },
    ]);
    const [schemaChanged] = await upsertDiscoveredTools(db(), server.id, [
      {
        name: "read",
        description: "read v2",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);

    expect(descriptionChanged?.version).not.toBe(first?.version);
    expect(schemaChanged?.version).not.toBe(descriptionChanged?.version);
  });

  it("revokes approval and risk classification only when discovery content changes", async () => {
    const server = await createMcpServer(db(), { name: "Version gate", url: "https://93.184.216.34/mcp" });
    const descriptor = { name: "read", description: "read v1", inputSchema: { type: "object" } };
    const [discovered] = await upsertDiscoveredTools(db(), server.id, [descriptor]);
    const approved = await setMcpServerToolApproval(db(), server.id, discovered!.id, {
      riskClass: "read_only",
      approved: true,
    });

    const [unchanged] = await upsertDiscoveredTools(db(), server.id, [descriptor]);
    expect(unchanged).toMatchObject({ approved: true, riskClass: "read_only", version: approved!.version });

    const [changed] = await upsertDiscoveredTools(db(), server.id, [{ ...descriptor, description: "read v2" }]);
    expect(changed).toMatchObject({ approved: false, riskClass: null });
    expect(changed!.version).not.toBe(approved!.version);
  });

  it("re-discovery removes tools the server no longer advertises", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    await upsertDiscoveredTools(db(), server.id, await discoverTools({ url: server.url }));

    await upsertDiscoveredTools(db(), server.id, [
      { name: "safe_read", description: "read", inputSchema: { type: "object" }, readOnlyHint: true },
    ]);

    expect((await listMcpServerTools(db(), server.id)).map((row) => row.toolName)).toEqual(["safe_read"]);
  });

  it("an empty discovery result does not wipe existing rows or approvals", async () => {
    // Regression test: a transient auth misconfiguration or mid-deploy blip
    // on the remote server can make one discovery pass legitimately return
    // zero tools without the server operator having removed anything. That
    // must not be indistinguishable from "every tool was deliberately
    // withdrawn" and silently destroy every human-set riskClass/approved
    // decision for the server.
    const server = await createMcpServer(db(), { name: "Flaky MCP", url: "https://93.184.216.34/mcp" });
    const [discovered] = await upsertDiscoveredTools(db(), server.id, [
      { name: "safe_read", description: "read", inputSchema: { type: "object" } },
    ]);
    await setMcpServerToolApproval(db(), server.id, discovered!.id, { riskClass: "read_only", approved: true });

    const rows = await upsertDiscoveredTools(db(), server.id, []);
    expect(rows).toEqual([]);

    const remaining = await listMcpServerTools(db(), server.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ toolName: "safe_read", approved: true, riskClass: "read_only" });
  });

  it("rolls back the entire catalog when a later discovered tool cannot be persisted", async () => {
    const server = await createMcpServer(db(), { name: "Atomic catalog", url: "https://93.184.216.34/mcp" });
    await upsertDiscoveredTools(db(), server.id, [
      { name: "old", description: "existing", inputSchema: { type: "object" } },
    ]);

    await expect(
      upsertDiscoveredTools(db(), server.id, [
        { name: "new", description: "would partially persist", inputSchema: { type: "object" } },
        { name: "broken", description: "cannot serialize", inputSchema: { invalid: 1n } },
      ]),
    ).rejects.toThrow();

    expect((await listMcpServerTools(db(), server.id)).map(({ toolName }) => toolName)).toEqual(["old"]);
  });

  it("an unapproved tool is not registered/callable", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const rows = await upsertDiscoveredTools(db(), server.id, await discoverTools({ url: server.url }));
    const registry = new ToolRegistry();
    const safe = rows.find((r) => r.toolName === "safe_read")!;
    await registerApprovedMcpTool(db(), registry, server.id, safe);
    expect(registry.has(mcpToolId(server.id, "safe_read"))).toBe(false);
  });

  it("approving a tool with a riskClass registers it and it's callable", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const rows = await upsertDiscoveredTools(db(), server.id, await discoverTools({ url: server.url }));
    const safe = rows.find((r) => r.toolName === "safe_read")!;

    const approved = await setMcpServerToolApproval(db(), server.id, safe.id, {
      riskClass: "read_only",
      approved: true,
    });
    expect(approved).toBeDefined();

    const registry = new ToolRegistry();
    await registerApprovedMcpTool(db(), registry, server.id, approved!);

    const id = mcpToolId(server.id, "safe_read");
    expect(registry.has(id)).toBe(true);
    const spec = registry.get(id);
    expect(spec.origin).toBe("mcp");
    expect(spec.namespace).toBe(server.id);
    expect(spec.version).toBe(approved!.version);
    expect(spec.riskClass).toBe("read_only");

    const result = await spec.run({});
    expect(result).toEqual({ status: "ok" });
  });

  it("deleting a server removes its tools (DB cascade + registry unregister)", async () => {
    const server = await createMcpServer(db(), { name: "Fake MCP", url: "https://93.184.216.34/mcp" });
    const rows = await upsertDiscoveredTools(db(), server.id, await discoverTools({ url: server.url }));
    const safe = rows.find((r) => r.toolName === "safe_read")!;
    const approved = await setMcpServerToolApproval(db(), server.id, safe.id, {
      riskClass: "read_only",
      approved: true,
    });

    const registry = new ToolRegistry();
    await registerApprovedMcpTool(db(), registry, server.id, approved!);
    const id = mcpToolId(server.id, "safe_read");
    expect(registry.has(id)).toBe(true);

    await deleteMcpServer(db(), server.id);
    unregisterMcpServer(registry, server.id);

    expect(registry.has(id)).toBe(false);
    expect(await listMcpServerTools(db(), server.id)).toHaveLength(0);
  });
});
