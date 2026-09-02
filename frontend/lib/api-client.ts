export interface AssignedToolConfig {
  toolId: string;
  permission?: "allow" | "ask";
  /** @deprecated Prefer `permission: "ask"`. Kept so legacy rows still load. */
  autonomy?: "approval_required";
}

export interface Persona {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  voiceNotes: string;
  boundaries: string;
  scopeDescription: string;
  modelProvider: string;
  modelName: string;
  assignedToolIds: AssignedToolConfig[];
  status: string;
  lastSummary: string;
  /** Org chart: the id of the persona this one reports to, or null for a
   *  top-of-chart persona. */
  reportsTo: string | null;
}

/** A small, opinionated starting point offered by "Hire a persona".
 *  Fields mirror PersonaCreateInput minus reportsTo/model, which are the
 *  hiring operator's decision, not the template's. `defaultTools` is
 *  already filtered server-side to tools registered on this deployment. */
export interface PersonaTemplate {
  slug: string;
  name: string;
  role: string;
  systemPrompt: string;
  voiceNotes: string;
  boundaries: string;
  scopeDescription: string;
  defaultTools: AssignedToolConfig[];
}

export interface PersonaGenerateRequest {
  description: string;
  seedTemplateSlug?: string;
}

/** The LLM's draft from POST /personas/generate. Same shape as a
 *  PersonaTemplate minus `slug`: a generated draft is a one-off template of
 *  one, prefilled into the hire form the same way. */
export interface PersonaGeneratedDraft {
  name: string;
  role: string;
  systemPrompt: string;
  voiceNotes: string;
  boundaries: string;
  scopeDescription: string;
  defaultTools: AssignedToolConfig[];
}

export interface PersonaCreateInput {
  name: string;
  role: string;
  systemPrompt: string;
  voiceNotes?: string;
  boundaries?: string;
  scopeDescription?: string;
  modelProvider: string;
  modelName: string;
  assignedToolIds: AssignedToolConfig[];
  reportsTo?: string | null;
}

/** A persona PATCH — every field optional and independent, merged onto the
 *  existing row. Mirrors PersonaCreateInput minus the requiredness: a
 *  persona's identity, charter, tools, model, and org-chart position are all
 *  expected to change as the tools and systems around it evolve, not just at
 *  hire time. `assignedToolIds`, when included, replaces the whole array. */
export interface PersonaUpdateInput {
  name?: string;
  role?: string;
  systemPrompt?: string;
  voiceNotes?: string;
  boundaries?: string;
  scopeDescription?: string;
  modelProvider?: string;
  modelName?: string;
  assignedToolIds?: AssignedToolConfig[];
  reportsTo?: string | null;
}

export interface Routine {
  id: string;
  personaId: string;
  name: string;
  cronSchedule: string;
  promptTemplate: string;
  notifyRoutineRan: boolean;
  enabled: boolean;
  lastFiredAt: string | null;
  lastSummary: string;
  // "job" (default) fires a normal chat job; "digest" calls generateDigest
  // directly instead, with no chat turn and no jobs row.
  kind: "job" | "digest";
}

export interface RoutineCreateInput {
  name: string;
  cronSchedule: string;
  promptTemplate: string;
  notifyRoutineRan?: boolean;
  kind?: "job" | "digest";
}

export interface RoutineUpdateInput {
  name?: string;
  cronSchedule?: string;
  promptTemplate?: string;
  notifyRoutineRan?: boolean;
  enabled?: boolean;
  kind?: "job" | "digest";
}

export interface Job {
  id: string;
  personaId: string;
  parentJobId: string | null;
  routineId: string | null;
  depth: number;
  origin: "cron" | "user" | "delegation";
  langgraphThreadId: string;
  status:
    | "queued"
    | "running"
    | "cancelling"
    | "waiting_approval"
    | "done"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "outcome_unknown";
  // Both nullable: rows created before these columns existed have neither.
  // `prompt` is what the job was actually asked to do; `error` is set only
  // when status is "failed" — see backend/src/jobs/job-repo.ts.
  prompt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  // Whether the chat's last turn can be redone from the last model turn
  // without risking a second external effect — see backend/src/jobs/
  // job-attempt-repo.ts's evaluateRetryEligibility. retryBlockedReason is
  // present (and retryEligible false) any time retry isn't currently safe,
  // including for statuses (done, queued, running, ...) where "retry"
  // doesn't even conceptually apply.
  retryEligible: boolean;
  retryBlockedReason?: string;
}

// A chat's message history now lives in its own table (GET /jobs/:id/
// messages), not a `transcript` blob on Job itself — see backend/src/db/
// schema.ts's messages doc comment.
export interface Message {
  id: string;
  jobId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type RiskClass = "read_only" | "reversible" | "destructive";

// Remote MCP server config plus its discovered tool catalog. See
// backend/src/db/schema.ts's mcp_servers / mcp_server_tools doc comments
// for the trust model (server hints are only an untrusted pre-fill;
// `riskClass` is null until a human confirms it) and
// docs/adr/0002-external-tools-via-mcp-adapters.md.
export interface McpServer {
  id: string;
  name: string;
  url: string;
  authType: "bearer" | "oauth";
  enabled: boolean;
  createdAt: string;
  toolCount: number;
  approvedCount: number;
  // Only present/meaningful for authType "oauth" — never a secret, just
  // config the form needs to prefill and a connected/not-connected flag.
  oauthConnected: boolean;
  oauthClientId?: string | null;
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
  oauthScope?: string | null;
}

export interface McpServerTool {
  id: string;
  serverId: string;
  toolName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  version: string;
  serverHintRiskClass: RiskClass | null;
  riskClass: RiskClass | null;
  approved: boolean;
  discoveredAt: string;
  updatedAt: string;
}

export interface McpServerCreateResult {
  server: McpServer;
  discovery:
    { ok: true; toolCount: number } | { ok: false; error?: string; errorCategory: string; remoteStatus?: number };
}

export interface CustomToolProposal {
  id: string;
  toolKey: string;
  version: number;
  description: string;
  source: string;
  parametersSchema: Record<string, unknown>;
  hostAllowList: string[];
  secretRefs: string[];
  limits: { timeoutMs: number; memoryMb: number; maxOutputBytes: number };
  suggestedRiskClass: RiskClass;
  status: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CustomToolProposalInput {
  description: string;
  source: string;
  parametersSchema: Record<string, unknown>;
  hostAllowList: string[];
  secretRefs: string[];
  limits: { timeoutMs: number; memoryMb: number; maxOutputBytes: number };
  suggestedRiskClass: RiskClass;
}

export interface AvailableMcpTool {
  id: string;
  label: string;
  sourceName: string;
  riskClass: RiskClass;
}
export type JobStatus = Job["status"];
export type ToolCallStatus = "pending_approval" | "approved" | "rejected" | "cancelled" | "executed" | "failed";

export interface ToolCall {
  id: string;
  jobId: string;
  callId: string | null;
  toolId: string;
  riskClass: RiskClass;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result: Record<string, unknown> | null;
  // Lets a historical chat merge this call into its messages timeline in
  // the order it actually happened — see the persona chat page's
  // buildTimeline.
  createdAt: string;
}

// One real generateText() call recorded by the backend's OnModelCall hook
// (persona-graph.ts's callModel → dispatcher.ts), success or failure — see
// backend/src/db/schema.ts's modelCalls table. `model`/tokens/finishReason
// are null when the call itself threw before a response came back; `error`
// is set only in that case.
export interface ModelCall {
  id: string;
  jobId: string;
  personaId: string;
  provider: string;
  model: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

export type NotificationKind =
  "approval_needed" | "question" | "job_finished" | "job_failed" | "routine_ran" | "connector_broke";

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  personaId: string | null;
  jobId: string | null;
  toolCallId: string | null;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  actedAt: string | null;
}

export interface NotificationPage {
  items: NotificationRow[];
  nextCursor: string | null;
}

export interface NotificationPreference {
  kind: NotificationKind;
  inAppEnabled: boolean;
  pushEnabled: boolean;
  digestEnabled: boolean;
}

export interface QuietHours {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}

// Named loop/task blob from persona_state (GET /personas/:id/state).
// Separate from Memory on purpose — wholesale overwrite vs additive facts;
// see docs/adr/0003-three-memory-stores.md.
export interface PersonaStateEntry {
  id: string;
  personaId: string;
  key: string;
  content: string;
  updatedAt: string;
}

// Durable fact memory (persona-memory-plan.md Phase 2) -- see backend/src/
// db/schema.ts's `personaMemories` doc comment for the full reasoning.
// `GET /personas/:id/memories` only ever returns "live" rows (not
// superseded, not expired) -- persona-memory-repo.ts's listMemories filters
// that server-side, so this type has no supersededAt-is-set case to render.
export interface Memory {
  id: string;
  personaId: string;
  label: string;
  content: string;
  sourceJobId: string | null;
  supersedesId: string | null;
  supersededAt: string | null;
  sensitivity: "normal" | "sensitive";
  importance: 0 | 1 | 2;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface Digest {
  id: string;
  personaId: string;
  routineId: string | null;
  generatedAt: string;
  content: string;
}

// Mirrors stream-routes.ts's own TERMINAL set on the backend — once a job's
// status reaches one of these, the backend ends the SSE response for good.
const TERMINAL_JOB_STATUSES = new Set([
  "done",
  "failed",
  "waiting_approval",
  "cancelled",
  "timed_out",
  "outcome_unknown",
]);

/** GET /config — which LLM provider API keys are configured server-side,
 *  and `ready`, the coarser "is at least one configured at all" check.
 *  AppShell polls this and blocks the whole app with setup instructions
 *  when `ready` is false; job-routes.ts enforces the same per-persona
 *  check server-side so a stale/second tab can't slip a job past it. */
export interface ConfigStatus {
  availableProviders: string[];
  ready: boolean;
  webSearchAvailable: boolean;
}

export interface PushConfig {
  available: boolean;
  publicKey: string | null;
  deviceCount: number;
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** GET /models — each configured provider's live model list, fetched
 *  server-side from that provider's own API (backend/src/models/model-
 *  catalog.ts). Backs the model picker dropdown: only a provider with an
 *  API key configured has an entry, and that entry is `[]` rather than
 *  missing if the live fetch itself failed. */
export interface ModelCatalog {
  models: Record<string, string[]>;
}

/** The least-privilege capabilities an owner can grant to a named MCP
 * control client. Write scopes deliberately do not imply their paired read
 * scope: callers must send every intended capability explicitly. */
export type ControlScope =
  | "personas:read"
  | "jobs:read"
  | "jobs:write"
  | "routines:read"
  | "routines:write"
  | "approvals:read"
  | "approvals:write"
  | "audit:read";

/** The public owner-facing projection. The backend never returns a token
 * hash, and it returns the plaintext token only from client creation. */
export interface ControlClient {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ControlScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ControlClientPage {
  items: ControlClient[];
  nextCursor: string | null;
}

interface ErrorBody {
  error: unknown;
}

// `body` is deliberately `unknown` here -- these two functions ARE the I/O
// boundary parser this rule otherwise wants called before accepting one:
// `body` is an arbitrary non-2xx response's parsed JSON, which by
// definition has no domain type until this parses it into one.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isErrorBody(body: unknown): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

// The one place this backend's `{ error: ... }` failure shape is parsed --
// every non-2xx route sends it (a missing-API-key message, a zod flatten,
// a plain string). This is the actual I/O boundary (called once, right
// where `request()` below has the raw response body), so ApiError itself
// takes the already-resolved `string | null`, not raw `unknown`.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function parseErrorDetail(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (!isErrorBody(body)) return null;
  // SAFETY: `isErrorBody` just confirmed `body` has an `error` property --
  // its value can be anything a route sent (a string, a zod flatten
  // object), which is why the non-string branch below falls back to
  // JSON.stringify rather than assuming a shape it hasn't checked.
  return typeof body.error === "string" ? body.error : JSON.stringify(body.error);
}

/** Typed request failure — carries the HTTP status so callers can special-case 401.
 *  Every route on this backend that rejects a request sends `{ error: ... }` with a
 *  real explanation (a missing-API-key message, a zod flatten, a plain string) — this
 *  used to be thrown away in favor of a generic "failed with 409", which is how a
 *  dialog with a perfectly good server message on hand ends up showing the user
 *  nothing but a status code. `detail` carries that message through when the body
 *  parses; callers fall back to the status-only message when it doesn't. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public detail: string | null,
  ) {
    super(detail ?? `request to ${path} failed with ${status}`);
    this.name = "ApiError";
  }
}

function idempotencyHeaders(idempotencyKey: string | undefined): HeadersInit | undefined {
  return idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private getPassword: () => string | null,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const password = this.getPassword();
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    if (password) headers.set("X-Auth-Password", password);

    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      throw new ApiError(res.status, path, parseErrorDetail(body));
    }
    // A 204 (e.g. DELETE /personas/:id/memories/:id) has no body -- res.json()
    // throws on empty input, so short-circuit before that for callers whose
    // declared T is void.
    if (res.status === 204) {
      // SAFETY: every call site that can receive a 204 declares T as void
      // (deleteMemory, deletePersonaState) -- undefined is a valid void,
      // this isn't standing in for real response data.
      return undefined as T;
    }
    // SAFETY: `T` is the response type each call site declares for its own
    // endpoint (e.g. listPersonas's Promise<Persona[]>) -- this method has
    // no schema of its own to check the JSON against; callers are trusting
    // their own knowledge of what that backend endpoint returns.
    return (await res.json()) as T;
  }

  listPersonas(): Promise<Persona[]> {
    return this.request<Persona[]>("/personas");
  }

  /** Starter templates for "Hire a persona". */
  listPersonaTemplates(): Promise<PersonaTemplate[]> {
    return this.request<PersonaTemplate[]>("/personas/templates");
  }

  /** Draft a persona from a freeform description. Never creates a
   *  persona; the caller prefills the hire form from the returned draft. */
  generatePersonaDraft(input: PersonaGenerateRequest): Promise<PersonaGeneratedDraft> {
    return this.request<PersonaGeneratedDraft>("/personas/generate", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getPersona(id: string): Promise<Persona> {
    return this.request<Persona>(`/personas/${id}`);
  }

  createPersona(input: PersonaCreateInput): Promise<Persona> {
    return this.request<Persona>("/personas", { method: "POST", body: JSON.stringify(input) });
  }

  /** Mutate a persona after hiring — identity, charter, tools, model, and/or
   *  org-chart position. Only the fields included in `input` are touched. */
  updatePersona(id: string, input: PersonaUpdateInput): Promise<Persona> {
    return this.request<Persona>(`/personas/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  /** Org chart: reassign who a persona reports to (null promotes it to the top of the chart). */
  setPersonaManager(id: string, reportsTo: string | null): Promise<Persona> {
    return this.updatePersona(id, { reportsTo });
  }

  /** Fix a persona's model after hiring, e.g. a bad or now-invalid model pick. */
  setPersonaModel(id: string, modelProvider: string, modelName: string): Promise<Persona> {
    return this.updatePersona(id, { modelProvider, modelName });
  }

  listRoutines(personaId?: string): Promise<Routine[]> {
    const query = personaId ? `?personaId=${personaId}` : "";
    return this.request<Routine[]>(`/routines${query}`);
  }

  createRoutine(personaId: string, input: RoutineCreateInput): Promise<Routine> {
    return this.request<Routine>(`/personas/${personaId}/routines`, { method: "POST", body: JSON.stringify(input) });
  }

  deleteRoutine(id: string): Promise<{ status: string }> {
    return this.request(`/routines/${id}`, { method: "DELETE" });
  }

  updateRoutine(id: string, patch: RoutineUpdateInput): Promise<Routine> {
    return this.request<Routine>(`/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  /** Toggle convenience over updateRoutine -- what the roster page's pause/resume control uses. */
  setRoutineEnabled(id: string, enabled: boolean): Promise<Routine> {
    return this.updateRoutine(id, { enabled });
  }

  /** Toggle convenience over updateRoutine -- the routines panel notify checkbox. */
  setRoutineNotifyRoutineRan(id: string, notifyRoutineRan: boolean): Promise<Routine> {
    return this.updateRoutine(id, { notifyRoutineRan });
  }

  runRoutineNow(id: string): Promise<{ status: string }> {
    return this.request(`/routines/${id}/run-now`, { method: "POST" });
  }

  listJobs(personaId?: string): Promise<Job[]> {
    const query = personaId ? `?personaId=${personaId}` : "";
    return this.request<Job[]>(`/jobs${query}`);
  }

  listChildJobs(parentJobId: string): Promise<Job[]> {
    return this.request<Job[]>(`/jobs?parentJobId=${encodeURIComponent(parentJobId)}`);
  }

  getJob(id: string): Promise<Job> {
    return this.request<Job>(`/jobs/${id}`);
  }

  /** A job/chat's message history, oldest first — see backend/src/jobs/
   *  message-repo.ts. Doesn't include tool activity; merge with
   *  listToolCallsForJob by createdAt for a full historical timeline. */
  listMessages(jobId: string): Promise<Message[]> {
    return this.request<Message[]>(`/jobs/${jobId}/messages`);
  }

  createJob(
    input: { personaId: string; prompt: string; notifyOnOutcome?: boolean },
    idempotencyKey?: string,
  ): Promise<Job> {
    return this.request<Job>("/jobs", {
      method: "POST",
      body: JSON.stringify(input),
      headers: idempotencyHeaders(idempotencyKey),
    });
  }

  /** Continues an existing chat with a new message on the same thread,
   *  instead of starting a brand-new isolated job — see backend/src/jobs/
   *  job-routes.ts's POST /jobs/:id/continue. 409s if the job is still
   *  queued, running, or waiting on approval. Pass the same idempotencyKey
   *  on retry so a lost response does not enqueue a second turn. */
  continueJob(id: string, prompt: string, notifyOnOutcome = false, idempotencyKey?: string): Promise<Job> {
    return this.request<Job>(`/jobs/${id}/continue`, {
      method: "POST",
      body: JSON.stringify({ prompt, notifyOnOutcome }),
      headers: idempotencyHeaders(idempotencyKey),
    });
  }

  /** Redoes the chat's last turn from the last model turn — only when the
   *  backend judges it safe (Job.retryEligible). See backend/src/jobs/
   *  job-routes.ts's POST /jobs/:id/retry. 409s if it isn't. */
  retryJob(id: string, idempotencyKey?: string): Promise<Job> {
    return this.request<Job>(`/jobs/${id}/retry`, {
      method: "POST",
      headers: idempotencyHeaders(idempotencyKey),
    });
  }

  cancelJob(id: string): Promise<Job> {
    return this.request<Job>(`/jobs/${id}/cancel`, { method: "POST" });
  }

  listPendingToolCalls(): Promise<ToolCall[]> {
    return this.request<ToolCall[]>("/tool_calls?status=pending_approval");
  }

  /** Every tool_calls row — pending, approved, rejected, executed, failed —
   *  the audit trail (05-job-creation-and-audit-ui.md). */
  listAllToolCalls(): Promise<ToolCall[]> {
    return this.request<ToolCall[]>("/tool_calls");
  }

  listToolCallsForJob(jobId: string): Promise<ToolCall[]> {
    return this.request<ToolCall[]>(`/tool_calls?jobId=${jobId}`);
  }

  /** A persona's recent model calls (cost/latency telemetry), most recent
   *  first — see backend/src/models/model-call-repo.ts's
   *  listModelCallsByPersona, capped at RECENT_MODEL_CALLS_LISTED there. */
  listModelCalls(personaId: string): Promise<ModelCall[]> {
    return this.request<ModelCall[]>(`/personas/${personaId}/model_calls`);
  }

  getToolCall(id: string): Promise<ToolCall> {
    return this.request<ToolCall>(`/tool_calls/${id}`);
  }

  approveToolCall(id: string): Promise<ToolCall> {
    return this.request<ToolCall>(`/tool_calls/${id}/approve`, { method: "POST" });
  }

  /** Approve this call and persist Allow on the persona so later chat turns
   *  and routine runs skip the Ask prompt. Destructive tools are rejected
   *  server-side (400). */
  alwaysAllowToolCall(id: string): Promise<ToolCall> {
    return this.request<ToolCall>(`/tool_calls/${id}/always-allow`, { method: "POST" });
  }

  rejectToolCall(id: string): Promise<ToolCall> {
    return this.request<ToolCall>(`/tool_calls/${id}/reject`, { method: "POST" });
  }

  listNotifications(opts: { cursor?: string; limit?: number; needsYou?: boolean } = {}): Promise<NotificationPage> {
    const params = new URLSearchParams();
    if (opts.needsYou) params.set("needs_you", "true");
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const query = params.toString();
    return this.request<NotificationPage>(`/notifications${query ? `?${query}` : ""}`);
  }

  markNotificationRead(id: string): Promise<NotificationRow> {
    return this.request<NotificationRow>(`/notifications/${id}/read`, { method: "POST" });
  }

  markAllNotificationsRead(): Promise<{ updated: number }> {
    return this.request<{ updated: number }>("/notifications/read_all", { method: "POST" });
  }

  getNotificationPreferences(): Promise<NotificationPreference[]> {
    return this.request<NotificationPreference[]>("/notifications/preferences");
  }

  updateNotificationPreference(
    kind: NotificationKind,
    patch: { inAppEnabled?: boolean; pushEnabled?: boolean; digestEnabled?: boolean },
  ): Promise<NotificationPreference> {
    return this.request<NotificationPreference>(`/notifications/preferences/${kind}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  getQuietHours(): Promise<QuietHours> {
    return this.request<QuietHours>("/notifications/quiet_hours");
  }

  updateQuietHours(patch: { enabled?: boolean; startMinute?: number; endMinute?: number }): Promise<QuietHours> {
    return this.request<QuietHours>("/notifications/quiet_hours", { method: "PATCH", body: JSON.stringify(patch) });
  }

  listDigests(personaId?: string): Promise<Digest[]> {
    const query = personaId ? `?personaId=${personaId}` : "";
    return this.request<Digest[]>(`/digests${query}`);
  }

  getDigest(id: string): Promise<Digest> {
    return this.request<Digest>(`/digests/${id}`);
  }

  /** Named loop/state blobs for the Memory tab -- persona-state-repo.ts's
   *  listState, most-recently-updated first. */
  listPersonaState(personaId: string): Promise<PersonaStateEntry[]> {
    return this.request<PersonaStateEntry[]>(`/personas/${personaId}/state`);
  }

  /** Deletes one loop-state key outright (write_state's forget_state). 204 on success. */
  deletePersonaState(personaId: string, key: string): Promise<void> {
    return this.request<void>(`/personas/${personaId}/state/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  /** Live (non-superseded, non-expired) memories for the Memory tab -- see
   *  persona-memory-repo.ts's listMemories, sorted importance-then-recency. */
  listMemories(personaId: string): Promise<Memory[]> {
    return this.request<Memory[]>(`/personas/${personaId}/memories`);
  }

  /** Deletes one memory outright (not a supersede -- real removal). 204 on success. */
  deleteMemory(personaId: string, memoryId: string): Promise<void> {
    return this.request<void>(`/personas/${personaId}/memories/${memoryId}`, { method: "DELETE" });
  }

  credentialStatus(toolId: string): Promise<{ toolId: string; configured: boolean }> {
    return this.request(`/credentials/${toolId}`);
  }

  /** Which model providers have an API key actually configured server-side
   *  (backend/src/config.ts), and whether at least one is — lets the
   *  persona-creation form warn about, or restrict to, a provider that
   *  would otherwise fail on its first job with no clue why, and lets
   *  AppShell gate the whole app on `ready`. */
  getConfig(): Promise<ConfigStatus> {
    return this.request<ConfigStatus>("/config");
  }

  getPushConfig(): Promise<PushConfig> {
    return this.request<PushConfig>("/push/config");
  }

  registerPushSubscription(subscription: PushSubscriptionPayload): Promise<{ registered: true }> {
    return this.request<{ registered: true }>("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify(subscription),
    });
  }

  deletePushSubscription(endpoint: string): Promise<void> {
    return this.request<void>("/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    });
  }

  /** Live model lists, one per configured provider — see ModelCatalog. */
  getModels(): Promise<ModelCatalog> {
    return this.request<ModelCatalog>("/models");
  }

  /** Adds a remote MCP server. A bearer-authType server attempts discovery
   *  in the same request (failure still creates the row — the human can
   *  retry via discoverMcpServerTools). An oauth-authType server never
   *  attempts discovery here — see startMcpServerOAuth. */
  createMcpServer(
    input:
      | { authType?: "bearer"; name: string; url: string; bearerToken?: string }
      | {
          authType: "oauth";
          name: string;
          url: string;
          oauthClientId: string;
          oauthClientSecret: string;
          oauthAuthorizationEndpoint: string;
          oauthTokenEndpoint: string;
          oauthScope: string;
        },
  ): Promise<McpServerCreateResult> {
    return this.request<McpServerCreateResult>("/mcp/servers", { method: "POST", body: JSON.stringify(input) });
  }

  /** Starts the OAuth handshake for an oauth-authType server. The caller
   *  must navigate the browser to the returned URL directly
   *  (window.location.href) — this is not a normal API response to render. */
  startMcpServerOAuth(serverId: string): Promise<{ authorizeUrl: string }> {
    return this.request(`/mcp/servers/${serverId}/oauth/start`, { method: "POST" });
  }

  listMcpServers(): Promise<McpServer[]> {
    return this.request<McpServer[]>("/mcp/servers");
  }

  updateMcpServer(serverId: string, patch: { enabled: boolean }): Promise<McpServer> {
    return this.request<McpServer>(`/mcp/servers/${serverId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  listAvailableMcpTools(): Promise<AvailableMcpTool[]> {
    return this.request<AvailableMcpTool[]>("/mcp/tools");
  }

  /** Re-runs discovery for an existing server, upserting its tool catalog. */
  discoverMcpServerTools(serverId: string): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    return this.request(`/mcp/servers/${serverId}/discover`, { method: "POST" });
  }

  listMcpServerTools(serverId: string): Promise<McpServerTool[]> {
    return this.request<McpServerTool[]>(`/mcp/servers/${serverId}/tools`);
  }

  /** The human-confirmation step — approved: true requires riskClass to be
   *  present (either here or already stored), enforced server-side. */
  updateMcpServerTool(
    serverId: string,
    toolId: string,
    patch: { riskClass?: RiskClass; approved?: boolean },
  ): Promise<McpServerTool> {
    return this.request<McpServerTool>(`/mcp/servers/${serverId}/tools/${toolId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  deleteMcpServer(serverId: string): Promise<{ status: string }> {
    return this.request(`/mcp/servers/${serverId}`, { method: "DELETE" });
  }

  createCustomTool(input: CustomToolProposalInput & { toolKey: string }): Promise<CustomToolProposal> {
    return this.request<CustomToolProposal>("/custom-tools", { method: "POST", body: JSON.stringify(input) });
  }

  createCustomToolVersion(toolKey: string, input: CustomToolProposalInput): Promise<CustomToolProposal> {
    return this.request<CustomToolProposal>(`/custom-tools/${toolKey}/versions`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listCustomTools(): Promise<CustomToolProposal[]> {
    return this.request<CustomToolProposal[]>("/custom-tools");
  }

  listCustomToolVersions(toolKey: string): Promise<CustomToolProposal[]> {
    return this.request<CustomToolProposal[]>(`/custom-tools/${toolKey}/versions`);
  }

  reviewCustomToolVersion(
    toolKey: string,
    version: number,
    input: { status: "approved" | "rejected"; reviewNote?: string },
  ): Promise<CustomToolProposal> {
    return this.request<CustomToolProposal>(`/custom-tools/${toolKey}/versions/${version}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /** Creates a named control-client token. The returned token is the only
   * plaintext disclosure; later list and revoke responses contain the
   * public ControlClient projection only. */
  createControlClient(input: {
    name: string;
    scopes: ControlScope[];
  }): Promise<{ client: ControlClient; token: string }> {
    return this.request<{ client: ControlClient; token: string }>("/control/clients", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Reads one cursor page of public control clients. */
  listControlClients(cursor?: string): Promise<ControlClientPage> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<ControlClientPage>(`/control/clients${query}`);
  }

  /** Revokes an active control client. Repeating a revoke returns its public
   * row, never a plaintext token or token hash. */
  revokeControlClient(id: string): Promise<ControlClient> {
    return this.request<ControlClient>(`/control/clients/${id}`, { method: "DELETE" });
  }

  streamJob(jobId: string, onEvent: (event: Record<string, unknown>) => void): () => void {
    const password = this.getPassword();
    const url = new URL(`${this.baseUrl}/jobs/${jobId}/stream`);
    if (password) url.searchParams.set("password", password);
    const source = new EventSource(url.toString());
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      onEvent(event);
      // The backend (stream-routes.ts) ends the response once the job hits
      // a terminal status, but EventSource auto-reconnects on *any*
      // connection close that it didn't itself trigger via .close() -- a
      // graceful server-side end looks the same as a dropped connection to
      // it. Left alone, the browser reopens this stream every few seconds
      // forever: the backend immediately re-sends the same terminal status
      // and ends again, and each round trip appends one more duplicate
      // entry to the caller's transcript for as long as the page stays
      // open. Mirrors stream-routes.ts's own TERMINAL set.
      if (event.type === "status" && TERMINAL_JOB_STATUSES.has(event.status)) {
        source.close();
      }
    };
    return () => source.close();
  }

  /**
   * Workspace pending-approval snapshots. Unlike streamJob this connection
   * stays open for the lifetime of the page: the backend never ends it, and
   * a reconnect (EventSource does that on its own) just gets a fresh
   * snapshot so a missed live event cannot leave the badge stuck.
   */
  streamPendingApprovals(onItems: (items: ToolCall[]) => void): () => void {
    const password = this.getPassword();
    const url = new URL(`${this.baseUrl}/pending_approvals/stream`);
    if (password) url.searchParams.set("password", password);
    const source = new EventSource(url.toString());
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event?.type === "pending" && Array.isArray(event.items)) onItems(event.items);
    };
    return () => source.close();
  }

  /** Workspace notification snapshots -- same long-lived shape as
   *  streamPendingApprovals, on a sibling stream (see notification-bus.ts). */
  streamNotifications(onItems: (items: NotificationRow[]) => void): () => void {
    const password = this.getPassword();
    const url = new URL(`${this.baseUrl}/notifications/stream`);
    if (password) url.searchParams.set("password", password);
    const source = new EventSource(url.toString());
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event?.type === "notifications" && Array.isArray(event.items)) onItems(event.items);
    };
    return () => source.close();
  }
}
