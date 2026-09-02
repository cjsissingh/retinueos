import { Agent as UndiciAgent, type Dispatcher } from "undici";
import { assertRemoteMcpDestination } from "./mcp-url.js";

export interface McpServerConnection {
  url: string;
  bearerToken?: string | null;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export type McpClientErrorCategory =
  | "unsafe_destination"
  | "unreachable"
  | "remote_http"
  | "invalid_response"
  | "protocol"
  | "response_too_large"
  | "pagination"
  | "oauth_reauth_required"
  | "tool_failure";

const PUBLIC_ERROR_MESSAGES = {
  unsafe_destination: "MCP server destination is not allowed",
  unreachable: "Couldn't reach the MCP server",
  remote_http: "The MCP server rejected the request",
  invalid_response: "The MCP server returned an invalid response",
  protocol: "The MCP server does not support the required protocol or tools capability",
  response_too_large: "The MCP server returned an oversized response",
  pagination: "The MCP server returned an invalid paginated tool catalog",
  oauth_reauth_required: "The MCP server's OAuth authorization must be renewed",
  tool_failure: "The MCP tool reported a failure",
} satisfies Record<McpClientErrorCategory, string>;

interface McpErrorDetail {
  status?: number;
  rpcCode?: number;
  isError?: true;
  content?: Array<{ type: string; text?: string }>;
}

interface PublicMcpError {
  error: string;
  errorCategory: McpClientErrorCategory;
  remoteStatus?: number;
}

export class McpClientError extends Error {
  readonly externalOutcomeKnown: boolean;

  constructor(
    readonly category: McpClientErrorCategory,
    readonly cause?: unknown,
    readonly detail?: McpErrorDetail,
  ) {
    super(PUBLIC_ERROR_MESSAGES[category]);
    this.name = "McpClientError";
    // `tool_failure` is created only after tools/call returned a valid JSON-RPC
    // result with isError=true. That is a known provider outcome, unlike a
    // timeout, disconnect, invalid response, or HTTP failure.
    this.externalOutcomeKnown = category === "tool_failure";
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- parses the catch-clause boundary into a public MCP error category.
export function publicMcpError(error: unknown): PublicMcpError {
  if (!(error instanceof McpClientError)) {
    return { error: "MCP discovery failed", errorCategory: "invalid_response" };
  }
  const status = error.detail?.status;
  const result: PublicMcpError = {
    error: error.message,
    errorCategory: error.category,
  };
  if (typeof status === "number") result.remoteStatus = status;
  return result;
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_TOOL_LIST_PAGES = 100;
const MAX_TOOL_FAILURE_TEXT = 1024;
const REQUEST_TIMEOUT_MS = 30_000;

let requestCounter = 0;
function nextId(): number {
  requestCounter += 1;
  return requestCounter;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface McpSession {
  connection: McpServerConnection;
  signal?: AbortSignal;
  sessionId?: string;
  initialized: boolean;
}

export async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new McpClientError("response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new McpClientError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- validates the untyped JSON.parse boundary below.
function validateEnvelope<T>(value: unknown, requestId: number): JsonRpcResponse<T> {
  if (!value || typeof value !== "object") throw new McpClientError("invalid_response");
  // SAFETY: the object check above permits reading optional envelope fields;
  // their required values are validated immediately below.
  const response = value as Partial<JsonRpcResponse<T>>;
  if (response.jsonrpc !== "2.0" || response.id !== requestId) throw new McpClientError("invalid_response");
  // SAFETY: jsonrpc and the correlated request id were checked; result/error
  // remain optional until rpcCall validates their mutually exclusive outcome.
  return response as JsonRpcResponse<T>;
}

function parseSseJsonRpc<T>(text: string, requestId: number): JsonRpcResponse<T> {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      // SAFETY: this guarded read only selects a candidate event; the complete
      // envelope is validated by validateEnvelope before it is returned.
      if (parsed && typeof parsed === "object" && (parsed as { id?: unknown }).id === requestId) {
        return validateEnvelope<T>(parsed, requestId);
      }
    } catch {
      // Ignore malformed unrelated events; a later event may be our response.
    }
  }
  throw new McpClientError("invalid_response");
}

function requestSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/** Builds an undici dispatcher that pins the outbound TCP connection to
 *  `address` — the exact address assertRemoteMcpDestination just validated —
 *  instead of letting fetch's own DNS resolution run a second, independent
 *  lookup that a hostile MCP server operator's authoritative DNS could
 *  answer differently (the DNS-rebinding SSRF bypass RemoteMcpDestination's
 *  doc comment describes). The `lookup` override only changes which IP the
 *  socket connects to; the request's URL/Host header and (for https) TLS SNI
 *  are untouched, so this is connection pinning, not host spoofing.
 *  Exported only for mcp-tools.test.ts to verify the pinning mechanism
 *  itself in isolation, not part of the module's public client API. */
export function pinnedDispatcher(address: { host: string; family: 4 | 6 }): Dispatcher {
  return new UndiciAgent({
    connections: 1,
    connect: {
      // undici's own connector `lookup` signature (mirrors node:dns's lookup
      // callback shape); this override always answers with the one
      // pre-validated address regardless of `_hostname`/`_options`, which is
      // the entire point of pinning.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      lookup: (
        _hostname: string,
        // oxlint-disable-next-line anti-slop/no-unknown-parameters
        _options: unknown,
        callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void,
      ) => callback(null, [{ address: address.host, family: address.family }]),
    },
  });
}

interface PostResult {
  response: Response;
  /** Set only when the destination hostname required a fresh DNS lookup;
   *  closed by the caller once the response body has been fully consumed. */
  dispatcher?: Dispatcher;
}

async function post(session: McpSession, payload: Record<string, unknown>): Promise<PostResult> {
  const signal = requestSignal(session.signal);
  let url: URL;
  let pinnedAddress: { host: string; family: 4 | 6 } | null;
  try {
    ({ url, address: pinnedAddress } = await assertRemoteMcpDestination(session.connection.url, undefined, signal));
  } catch (error) {
    if (signal.aborted) throw new McpClientError("unreachable", error);
    throw new McpClientError("unsafe_destination", error);
  }
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (session.connection.bearerToken) headers.set("authorization", `Bearer ${session.connection.bearerToken}`);
  if (session.sessionId) headers.set("mcp-session-id", session.sessionId);
  if (session.initialized) headers.set("mcp-protocol-version", PROTOCOL_VERSION);

  const dispatcher = pinnedAddress ? pinnedDispatcher(pinnedAddress) : undefined;
  // Node's global fetch (undici) accepts a per-request `dispatcher` to
  // override its default connection pool — this is how the pinned address
  // above actually reaches the socket instead of fetch running its own
  // independent DNS resolution.
  const dispatcherAsUnknown: unknown = dispatcher;
  // SAFETY: @types/node's RequestInit types `dispatcher` against its own
  // bundled undici-types copy, which isn't structurally identical to the
  // `undici` npm package's Dispatcher (their FormData iterator types differ)
  // even though both describe the same dispatcher contract Node's fetch
  // implementation actually accepts at runtime.
  const fetchDispatcher = dispatcherAsUnknown as RequestInit["dispatcher"];
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "manual",
      signal,
      dispatcher: fetchDispatcher,
    });
  } catch (error) {
    await dispatcher?.close();
    throw new McpClientError("unreachable", error);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    await dispatcher?.close();
    throw new McpClientError("remote_http", undefined, { status: response.status });
  }
  if (!response.ok) {
    await response.body?.cancel();
    await dispatcher?.close();
    throw new McpClientError("remote_http", undefined, { status: response.status });
  }
  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) session.sessionId = newSessionId;
  return { response, dispatcher };
}

async function rpcCall<T>(session: McpSession, method: string, params?: Record<string, unknown>): Promise<T> {
  const id = nextId();
  const { response, dispatcher } = await post(session, { jsonrpc: "2.0", id, method, params: params ?? {} });
  try {
    const text = await readBoundedText(response);
    let body: JsonRpcResponse<T>;
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      body = parseSseJsonRpc<T>(text, id);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new McpClientError("invalid_response", error);
      }
      body = validateEnvelope<T>(parsed, id);
    }
    if (body.error) throw new McpClientError("invalid_response", undefined, { rpcCode: body.error.code });
    if (body.result === undefined) throw new McpClientError("invalid_response");
    return body.result;
  } finally {
    await dispatcher?.close();
  }
}

async function notify(session: McpSession, method: string): Promise<void> {
  const { response, dispatcher } = await post(session, { jsonrpc: "2.0", method });
  try {
    await response.body?.cancel();
  } finally {
    await dispatcher?.close();
  }
}

interface InitializeResult {
  protocolVersion?: unknown;
  capabilities?: unknown;
  serverInfo?: unknown;
}

function validateInitializeResult(result: InitializeResult): void {
  // Per the MCP spec, a server negotiates and may legitimately return a
  // protocolVersion different from (but compatible with) the one this
  // client requested — strict equality would reject real, spec-compliant
  // servers. What actually matters for this client is a usable tools
  // capability, checked below; a version string mismatch alone only gets a
  // warning, not a hard failure, since a working tools/list afterward is the
  // real compatibility test.
  if (typeof result.protocolVersion !== "string" || result.protocolVersion.length === 0) {
    throw new McpClientError("protocol");
  }
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    console.warn(
      `MCP server negotiated protocolVersion ${result.protocolVersion}, this client requested ${PROTOCOL_VERSION}`,
    );
  }
  if (!result.capabilities || typeof result.capabilities !== "object" || !("tools" in result.capabilities)) {
    throw new McpClientError("protocol");
  }
  const serverInfo = result.serverInfo;
  if (
    !serverInfo ||
    typeof serverInfo !== "object" ||
    !("name" in serverInfo) ||
    !("version" in serverInfo) ||
    typeof serverInfo.name !== "string" ||
    typeof serverInfo.version !== "string"
  ) {
    throw new McpClientError("protocol");
  }
}

async function initialize(connection: McpServerConnection, signal?: AbortSignal): Promise<McpSession> {
  const session: McpSession = { connection, signal, initialized: false };
  const result = await rpcCall<InitializeResult>(session, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "retinueos-backend", version: "1.0.0" },
  });
  validateInitializeResult(result);
  session.initialized = true;
  await notify(session, "notifications/initialized");
  return session;
}

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function toolDescriptor(tool: RawTool): McpToolDescriptor {
  if (!tool || typeof tool.name !== "string" || tool.name.length === 0) throw new McpClientError("invalid_response");
  if (tool.inputSchema !== undefined && (!tool.inputSchema || typeof tool.inputSchema !== "object")) {
    throw new McpClientError("invalid_response");
  }
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    readOnlyHint: tool.annotations?.readOnlyHint,
    destructiveHint: tool.annotations?.destructiveHint,
  };
}

export async function discoverTools(server: McpServerConnection, signal?: AbortSignal): Promise<McpToolDescriptor[]> {
  const session = await initialize(server, signal);
  const tools: McpToolDescriptor[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let hasCursor = false;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const result = await rpcCall<{ tools?: RawTool[]; nextCursor?: unknown }>(
      session,
      "tools/list",
      hasCursor ? { cursor } : undefined,
    );
    if (!Array.isArray(result.tools)) throw new McpClientError("invalid_response");
    tools.push(...result.tools.map(toolDescriptor));
    if (!Object.hasOwn(result, "nextCursor")) return tools;
    if (typeof result.nextCursor !== "string" || seenCursors.has(result.nextCursor)) {
      throw new McpClientError("pagination");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    hasCursor = true;
  }
  throw new McpClientError("pagination");
}

function boundedToolFailureDetail(result: Record<string, unknown>): McpErrorDetail {
  const content = Array.isArray(result.content)
    ? result.content.slice(0, 10).map((item) => {
        if (!item || typeof item !== "object") return { type: "unknown" };
        // SAFETY: the object guard above makes optional remote content fields
        // readable; both are narrowed before use.
        const candidate = item as { type?: unknown; text?: unknown };
        const type = typeof candidate.type === "string" ? candidate.type.slice(0, 64) : "unknown";
        return typeof candidate.text === "string"
          ? { type, text: candidate.text.slice(0, MAX_TOOL_FAILURE_TEXT) }
          : { type };
      })
    : [];
  return { isError: true, content };
}

export async function callMcpTool(
  server: McpServerConnection,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const session = await initialize(server, signal);
  const result = await rpcCall<Record<string, unknown>>(session, "tools/call", { name: toolName, arguments: args });
  if (result.isError === true) throw new McpClientError("tool_failure", undefined, boundedToolFailureDetail(result));
  return result;
}
