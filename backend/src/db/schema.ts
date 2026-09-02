// backend/src/db/schema.ts
import {
  pgTable,
  text,
  integer,
  bigserial,
  boolean,
  jsonb,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ControlAction, ControlActor, ControlScope, ControlTargetType } from "../control/types.js";

/**
 * User-facing tool permission for a persona. Stored on assigned tools
 * (`blocked` is the absence of a row — see tools/autonomy.ts).
 *
 * Legacy records only have `autonomy?: "approval_required"`. Mapping:
 *   assigned, no override          → allow (Ask at runtime if destructive)
 *   assigned, approval_required    → ask
 *   not in assignedToolIds         → blocked
 *
 * `permission` is the explicit field new writes use. `autonomy` is kept as
 * a one-way "make it Ask" alias so existing rows and older clients still
 * load. The destructive ceiling still lives in tools/autonomy.ts: a
 * destructive tool cannot become Allow, even if a stored row looks like it.
 */
export type ToolPermission = "allow" | "ask" | "blocked";

export interface AssignedToolConfig {
  toolId: string;
  permission?: "allow" | "ask";
  /** @deprecated Prefer `permission: "ask"`. Kept so legacy rows still load. */
  autonomy?: "approval_required";
}

export type NotificationKind =
  "approval_needed" | "question" | "job_finished" | "job_failed" | "routine_ran" | "connector_broke";

export const personas = pgTable(
  "personas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    // Structured charter fields, templated together with systemPrompt into the
    // actual prompt sent to the model (see graph/charter.ts). All optional —
    // a persona with none of these behaves exactly as before.
    voiceNotes: text("voice_notes").notNull().default(""),
    boundaries: text("boundaries").notNull().default(""),
    scopeDescription: text("scope_description").notNull().default(""),
    modelProvider: text("model_provider").notNull(),
    modelName: text("model_name").notNull(),
    assignedToolIds: jsonb("assigned_tool_ids").$type<AssignedToolConfig[]>().notNull().default([]),
    status: text("status").notNull().default("idle"),
    lastSummary: text("last_summary").notNull().default(""),
    // Control-plane pagination uses this immutable ordering key rather than a
    // mutable charter field or UUID-only ordering.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Org chart: the persona this one reports to, or null for a top-of-chart
    // persona (the Principal is typically the only one with no manager).
    // Self-referencing FK, nullable, ON DELETE SET NULL so dismissing a
    // manager (once that exists) doesn't cascade-orphan the whole subtree —
    // it just promotes their reports to the top level. Cycle prevention
    // (a persona can't end up reporting, transitively, to itself) is
    // enforced in personas/persona-repo.ts, not at the DB level.
    reportsTo: uuid("reports_to").references((): AnyPgColumn => personas.id, { onDelete: "set null" }),
  },
  (table) => ({
    createdAtIndex: index("personas_created_at_idx").on(table.createdAt, table.id),
  }),
);

export const routines = pgTable("routines", {
  id: uuid("id").primaryKey().defaultRandom(),
  personaId: uuid("persona_id")
    .notNull()
    .references(() => personas.id),
  name: text("name").notNull(),
  cronSchedule: text("cron_schedule").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  // "job" (default) fires a normal chat job via createQueuedJob, seeded with
  // promptTemplate/lastSummary same as before this column existed. "digest"
  // calls generateDigest directly instead -- no jobs row, no chat turn --
  // for routines whose whole purpose is "scan my own state and recent job
  // outcomes and report back."
  kind: text("kind").$type<"job" | "digest">().notNull().default("job"),
  // Renamed from `notifyDirect`: drives the routine_ran push
  // channel for this routine's own runs. job/digest outcome notifications
  // (job_finished/job_failed) are governed by the global delivery matrix
  // and the per-chat "notify me when done" override instead -- this column
  // is routine-scoped, not job-scoped.
  notifyRoutineRan: boolean("notify_routine_ran").notNull().default(false),
  // Missing-feature-surface item from the 2026-08-22 architecture review:
  // "Routine enable/disable." A disabled routine's row (and its schedule,
  // last-fired/last-summary history) survives untouched -- only whether
  // PersonaScheduler.registerAll gives it a live cron task changes (see
  // scheduler.ts's reschedule). Pausing a routine you might turn back on
  // shouldn't mean deleting it and losing its history.
  enabled: boolean("enabled").notNull().default(true),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  lastSummary: text("last_summary").notNull().default(""),
});

// Named credentials for external control-plane clients. The credential itself
// is never persisted; only its SHA-256 digest and a non-secret display prefix
// are retained.
export const controlClients = pgTable(
  "control_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: jsonb("scopes").$type<ControlScope[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("control_clients_token_hash_idx").on(table.tokenHash),
  }),
);

// Durable idempotency records for control-plane writes. Target identifiers are
// deliberately plain text: they are polymorphic and records must survive the
// deletion of their target resources.
export const controlOperations = pgTable(
  "control_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorKey: text("actor_key").notNull(),
    action: text("action").$type<ControlAction>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    argumentsHash: text("arguments_hash").notNull(),
    status: text("status").$type<"in_progress" | "completed" | "failed">().notNull().default("in_progress"),
    targetType: text("target_type").$type<ControlTargetType>(),
    targetId: text("target_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCategory: text("error_category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    actorActionIdempotencyUnique: uniqueIndex("control_operations_actor_action_idempotency_idx").on(
      table.actorKey,
      table.action,
      table.idempotencyKey,
    ),
  }),
);

// An indefinitely retained audit history for the control plane. Actor and
// target identifiers intentionally have no foreign keys so audit rows remain
// meaningful after a related client, job, routine, or tool call is deleted.
export const controlAuditEvents = pgTable(
  "control_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorKind: text("actor_kind").$type<ControlActor["kind"]>().notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").$type<ControlAction>().notNull(),
    targetType: text("target_type").$type<ControlTargetType>(),
    targetId: text("target_id"),
    sourceJobId: text("source_job_id"),
    sourceToolCallId: text("source_tool_call_id"),
    mcpRequestId: text("mcp_request_id"),
    idempotencyKey: text("idempotency_key"),
    correlationId: text("correlation_id"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    outcome: text("outcome").$type<"pending" | "succeeded" | "failed">().notNull().default("pending"),
    errorCategory: text("error_category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => ({
    createdAtIndex: index("control_audit_events_created_at_idx").on(table.createdAt, table.id),
  }),
);

export type JobAttemptInput =
  | { type: "user_message"; content: string }
  | { type: "approval_resume"; toolCallId: string; approved: boolean }
  | { type: "retry" };

/**
 * How a job started. A subtype of tools/job-origin-policy.ts's JobOrigin
 * (which also has "webhook", a reserved origin that nothing constructs
 * yet) — kept local rather than imported so db/schema.ts doesn't depend on
 * tools/.
 */
export type JobStartOrigin = "cron" | "user" | "delegation";

export type JobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown";

export type JobAttemptStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "done"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown"
  | "abandoned";

export type AttemptCancelReason = "user" | "deadline";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personaId: uuid("persona_id")
      .notNull()
      .references(() => personas.id),
    // Both nullable and, unlike personaId above, previously had no FK at all —
    // an oversight, not a deliberate looser-coupling choice (nothing else in
    // this schema treats a relationship that way). `onDelete: "set null"`
    // rather than the default `no action`: a job is a historical record that
    // should survive its parent job or routine being deleted, just with the
    // link cleared, not block that deletion outright — the routines table's
    // own DELETE /routines/:id route has no reason to start failing once a
    // routine has fired at least once.
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => jobs.id, { onDelete: "set null" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    depth: integer("depth").notNull().default(0),
    origin: text("origin").$type<JobStartOrigin>().notNull(),
    langgraphThreadId: text("langgraph_thread_id").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    // The task this job was actually given — a delegation's `task` string or
    // a routine's seed message, same as `user` origin's raw prompt. Nullable
    // only because rows created before this column existed have nothing to
    // backfill it with; every job created from here on sets it. Without this,
    // a job's own detail page couldn't say what it was even asked to do.
    prompt: text("prompt"),
    // Set when status becomes "failed" so the failure is visible somewhere
    // other than a server console.error that nobody but the operator ever
    // sees — execution failures are written by dispatcher.ts's guarded
    // running-to-failed transition.
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    validStatus: check(
      "jobs_status_valid",
      sql`${table.status} in ('queued', 'running', 'cancelling', 'waiting_approval', 'done', 'failed', 'cancelled', 'timed_out', 'outcome_unknown')`,
    ),
  }),
);

// A job/chat's message history — one row per turn, replacing the old
// `jobs.transcript` jsonb blob (2026-08-22 architecture review: "Canonical
// structured messages ... not a second text-only JSON transcript beside
// LangGraph state"). Written by jobs/message-repo.ts's createMessage: a user
// message when the job is created or continued (POST /jobs, POST
// /jobs/:id/continue), an assistant message when a graph turn produces one
// (dispatcher.ts's driveTurn). Plain INSERTs, in the same transaction as
// whatever else that turn is doing (job-attempt-repo.ts's applyEffects) —
// no read-modify-write race to guard against the way the old jsonb-concat
// approach needed, since each turn is its own row instead of a mutation of
// one shared column.
//
// Deliberately still just role+content, not yet tool calls/attachments/
// citations/artifacts folded in as message content: those already have a
// durable home (tool_calls), and interleaving them into one historical
// timeline is GET /jobs/:id/messages plus GET /tool_calls?jobId=, merged by
// createdAt on the client (see frontend/app/roster/[personaId]/page.tsx) —
// not a reason to duplicate tool_calls' own columns into this table.
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "user" | "assistant"
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    validRole: check("messages_role_valid", sql`${table.role} in ('user', 'assistant')`),
    jobIdIndex: index("messages_job_id_idx").on(table.jobId, table.createdAt),
  }),
);

/**
 * One durable execution segment for a job/chat. A fresh prompt, a
 * continuation, and an approval resume each get their own row and input.
 * The attempt is the queue item and, once claimed, its id + workerId are the
 * fencing identity for heartbeat and settlement.
 */
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    input: jsonb("input").$type<JobAttemptInput>().notNull(),
    notifyOnOutcome: boolean("notify_on_outcome").notNull().default(false),
    status: text("status").$type<JobAttemptStatus>().notNull().default("queued"),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    cancelReason: text("cancel_reason").$type<AttemptCancelReason>(),
    abortAfter: timestamp("abort_after", { withTimezone: true }),
    // Set immediately before a reversible/destructive external call and
    // cleared in the same fenced transaction that records its audit result.
    // A marker left behind at cancellation/recovery means the provider's
    // outcome cannot be proven and must surface as outcome_unknown.
    externalEffectCallId: text("external_effect_call_id"),
    externalEffectStartedAt: timestamp("external_effect_started_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobSequenceUnique: uniqueIndex("job_attempts_job_sequence_idx").on(table.jobId, table.sequence),
    oneActivePerJob: uniqueIndex("job_attempts_one_active_per_job_idx")
      .on(table.jobId)
      .where(sql`${table.status} in ('queued', 'running')`),
    claimIndex: index("job_attempts_claim_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    expiredLeaseIndex: index("job_attempts_expired_lease_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.status} = 'running'`),
    deadlineIndex: index("job_attempts_deadline_idx")
      .on(table.deadlineAt, table.id)
      .where(sql`${table.status} = 'running' and ${table.cancelRequestedAt} is null`),
    abortAfterIndex: index("job_attempts_abort_after_idx")
      .on(table.abortAfter, table.id)
      .where(sql`${table.status} = 'running' and ${table.cancelRequestedAt} is not null`),
    positiveSequence: check("job_attempts_sequence_positive", sql`${table.sequence} > 0`),
    validStatus: check(
      "job_attempts_status_valid",
      sql`${table.status} in ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled', 'timed_out', 'outcome_unknown', 'abandoned')`,
    ),
    validCancellation: check(
      "job_attempts_cancellation_valid",
      sql`(
        ${table.cancelRequestedAt} is null
        and ${table.cancelReason} is null
        and ${table.abortAfter} is null
      ) or (
        ${table.cancelRequestedAt} is not null
        and ${table.cancelReason} in ('user', 'deadline')
        and ${table.abortAfter} is not null
        and ${table.abortAfter} > ${table.cancelRequestedAt}
      )`,
    ),
    validExternalEffect: check(
      "job_attempts_external_effect_valid",
      sql`(${table.externalEffectCallId} is null) = (${table.externalEffectStartedAt} is null)`,
    ),
    validInput: check(
      "job_attempts_input_valid",
      sql`(
        jsonb_typeof(${table.input}) = 'object'
        and (
          (${table.input}->>'type' = 'user_message' and jsonb_typeof(${table.input}->'content') = 'string')
          or (
            ${table.input}->>'type' = 'approval_resume'
            and jsonb_typeof(${table.input}->'toolCallId') = 'string'
            and jsonb_typeof(${table.input}->'approved') = 'boolean'
          )
          or ${table.input}->>'type' = 'retry'
        )
      ) is true`,
    ),
    validLifecycle: check(
      "job_attempts_lifecycle_valid",
      sql`(
        ${table.status} = 'queued'
        and ${table.workerId} is null
        and ${table.leaseExpiresAt} is null
        and ${table.lastHeartbeatAt} is null
        and ${table.startedAt} is null
        and ${table.finishedAt} is null
        and ${table.deadlineAt} is null
        and ${table.cancelRequestedAt} is null
        and ${table.externalEffectCallId} is null
      ) or (
        ${table.status} = 'running'
        and ${table.workerId} is not null
        and ${table.leaseExpiresAt} is not null
        and ${table.lastHeartbeatAt} is not null
        and ${table.startedAt} is not null
        and ${table.finishedAt} is null
        and ${table.deadlineAt} is not null
      ) or (
        ${table.status} in ('waiting_approval', 'done', 'failed', 'cancelled', 'timed_out', 'outcome_unknown', 'abandoned')
        and ${table.workerId} is not null
        and ${table.leaseExpiresAt} is not null
        and ${table.lastHeartbeatAt} is not null
        and ${table.startedAt} is not null
        and ${table.finishedAt} is not null
        and ${table.deadlineAt} is not null
      ) or (
        ${table.status} = 'cancelled'
        and ${table.workerId} is null
        and ${table.leaseExpiresAt} is null
        and ${table.lastHeartbeatAt} is null
        and ${table.startedAt} is null
        and ${table.finishedAt} is not null
        and ${table.deadlineAt} is null
      )`,
    ),
  }),
);

export const toolCalls = pgTable("tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id),
  // Which attempt (job_attempts row) this call happened in. Nullable: rows
  // written before this column existed, and rows written by the legacy
  // runJob path (orchestration/dispatcher.ts, test-only — no job_attempts
  // row exists for that path) have none. Attempts run strictly sequentially
  // per job (job_attempts.oneActivePerJob), so this is an unambiguous
  // per-turn correlation, not just a hint — safe-retry eligibility
  // (jobs/job-attempt-repo.ts's evaluateRetryEligibility) depends on it.
  jobAttemptId: uuid("job_attempt_id").references(() => jobAttempts.id, { onDelete: "set null" }),
  // The model/LangGraph tool-call id (e.g. `result.toolCalls[i].toolCallId`
  // from the AI SDK) — lets the dispatcher find this row again after a
  // gated call resumes and actually executes, to write its real result back
  // (see orchestration/dispatcher.ts's onToolExecuted). Nullable because it
  // predates rows written before this correlation existed.
  callId: text("call_id"),
  toolId: text("tool_id").notNull(),
  riskClass: text("risk_class").notNull(), // read_only|reversible|destructive
  arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending_approval"), // pending_approval|approved|rejected|cancelled|executed|failed
  result: jsonb("result").$type<Record<string, unknown> | null>(),
  // Lets a historical chat view merge-sort this call into the messages
  // timeline by when it actually happened (frontend/app/roster/[personaId]/
  // page.tsx).
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Semi-structured, addressable persona-owned state. `key` is a routine- or
// persona-chosen namespace (e.g. "inbox-suggestions", "deliveries"); one row
// per (persona, key) is read and written wholesale via the read_state/
// write_state tools. See docs/adr/0003-three-memory-stores.md.
export const personaState = pgTable(
  "persona_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personaId: uuid("persona_id")
      .notNull()
      .references(() => personas.id),
    key: text("key").notNull(),
    content: text("content").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    personaKeyUnique: uniqueIndex("persona_state_persona_id_key_idx").on(table.personaId, table.key),
  }),
);

// Durable fact memory — deliberately a separate table from persona_state
// above, not a variant of it. persona_state is one named blob overwritten
// wholesale (a loop/task tracker: "the inbox-suggestions list"); a memory is
// a small, independent, additive record ("Operator's spouse is named X") that
// should never require reading and rewriting an unrelated blob to persist.
// See docs/adr/0003-three-memory-stores.md for why these stay split rather
// than merging into one "memory" table, and why chat/job summaries
// (jobs.transcript, routines.last_summary) are a third store again, not
// folded in here: writing a private chat summary into persona-wide memory
// would leak chat-specific context into every future conversation.
//
// `label` is a soft key, not a uniqueness constraint (unlike persona_state's
// key): remember() with a `label` that already has a live (non-superseded)
// row marks that row superseded and inserts a new one, so a persona can
// correct itself ("Operator moved to Seattle") without silently overwriting —
// and without losing — what it used to believe. `supersedesId` links the new
// row back to the one it replaces; `supersededAt` marks the old row retired.
// Both null for a live, never-revised memory.
export const personaMemories = pgTable("persona_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  personaId: uuid("persona_id")
    .notNull()
    .references(() => personas.id),
  label: text("label").notNull(),
  content: text("content").notNull(),
  // Which job produced this memory, for provenance ("why do you believe
  // this?"). Nullable/SET NULL: a memory should outlive the job that
  // created it, the same reasoning as jobs.parentJobId above.
  sourceJobId: uuid("source_job_id").references((): AnyPgColumn => jobs.id, { onDelete: "set null" }),
  supersedesId: uuid("supersedes_id").references((): AnyPgColumn => personaMemories.id, { onDelete: "set null" }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  // "sensitive" memories are excluded from the automatic system-prompt
  // injection (memory-context.ts) — still reachable via an explicit recall()
  // call, but not repeated into every single turn's prompt regardless of
  // relevance. Keeps a persona's blast radius for one sensitive fact
  // ("Operator's SSN") from being "every future conversation," not just "every
  // conversation that actually asked."
  sensitivity: text("sensitivity").notNull().default("normal"), // "normal" | "sensitive"
  // Persona-set 0 (background) .. 2 (important) — one input to injection
  // ranking alongside recency, not a replacement for it. Defaults to the
  // middle tier rather than 0 so a plain remember() with no opinion doesn't
  // get automatically deprioritized against memories that did set one.
  importance: integer("importance").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Bumped on every recall() hit or system-prompt injection — a second axis
  // (independent of createdAt/updatedAt) for retrieval ranking and for
  // surfacing memories nothing has touched in a long time as prune
  // candidates. Nullable: null means "never read back," not "read back at
  // time zero."
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
});

// Integration credentials (OAuth tokens, API keys) for real tool connectors.
// Single-user deployment model (see config.ts) — one credential set per tool
// id, not per persona. `encryptedPayload` is AES-256-GCM ciphertext
// (see tools/credentials.ts); never store plaintext secrets here.
export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  toolId: text("tool_id").notNull().unique(),
  encryptedPayload: text("encrypted_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// AES-256-GCM scheme (encrypt/decrypt) rather than a second cipher — see
// tools/mcp-server-repo.ts. Null bearerToken means no Authorization header
// is sent at all, not "auth configured but empty."
//
// `authType` ("bearer" | "oauth", not a pg enum — same bare-`text`-plus-
// Zod-validation convention `mcp_server_tools.risk_class` below already
// uses, to keep this file free of a dependency on tools/) picks which
// credential shape is live: a "bearer" row only ever uses `bearerToken`;
// an "oauth" row uses the oauth_* columns below and leaves `bearerToken`
// null. oauth_client_secret/oauth_refresh_token/oauth_access_token are
// encrypted like bearerToken; oauth_client_id/the two endpoint URLs/scope
// are plaintext config, not secrets. oauth_pending_state(_expires_at) is a
// short-lived (10-minute), single-use CSRF token for the in-flight
// authorization-code round trip — see mcp-server-repo.ts's
// startMcpServerOAuth/consumeMcpServerOAuthState and
// docs/adr/0002-external-tools-via-mcp-adapters.md.
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  authType: text("auth_type").notNull().default("bearer"),
  bearerToken: text("bearer_token"),
  oauthClientId: text("oauth_client_id"),
  oauthClientSecret: text("oauth_client_secret"),
  oauthAuthorizationEndpoint: text("oauth_authorization_endpoint"),
  oauthTokenEndpoint: text("oauth_token_endpoint"),
  oauthScope: text("oauth_scope"),
  oauthRefreshToken: text("oauth_refresh_token"),
  oauthAccessToken: text("oauth_access_token"),
  oauthAccessTokenExpiresAt: timestamp("oauth_access_token_expires_at", { withTimezone: true }),
  oauthPendingState: text("oauth_pending_state"),
  oauthPendingStateExpiresAt: timestamp("oauth_pending_state_expires_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per tool discovered from an mcp_servers row's `tools/list` catalog.
// `parametersSchema` is the server's own JSON Schema, stored and later
// handed to ToolSpec.parameters as-is (07's "parameters passes the server's
// JSON schema through as-is"). `serverHintRiskClass` and `riskClass` are
// deliberately two separate columns, not one overwritten field: the former
// is the UNTRUSTED pre-fill derived from the server's own (self-reported,
// therefore unverifiable) readOnlyHint/destructiveHint annotations; the
// latter is null until a human explicitly confirms it, and only a non-null
// `riskClass` (with `approved`) makes this tool callable at all — a
// misconfigured or adversarial server marking a destructive action
// `readOnlyHint: true` must not be able to auto-approve itself. See 07's
// "riskClass cannot come from the server's own hints unreviewed."
export const mcpServerTools = pgTable(
  "mcp_server_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    description: text("description").notNull(),
    parametersSchema: jsonb("parameters_schema").$type<Record<string, unknown>>().notNull(),
    version: text("version").notNull(),
    // "read_only" | "reversible" | "destructive" (registry.ts's RiskClass) —
    // not imported here to keep db/schema.ts free of a dependency on
    // tools/, matching this file's existing style (tool_calls.riskClass
    // above is a bare `text` for the same reason).
    serverHintRiskClass: text("server_hint_risk_class"),
    riskClass: text("risk_class"),
    approved: boolean("approved").notNull().default(false),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Re-discovering a server's catalog upserts by (server, tool name)
    // instead of duplicating rows every time discovery reruns.
    serverToolUnique: uniqueIndex("mcp_server_tools_server_id_tool_name_idx").on(table.serverId, table.toolName),
  }),
);

// One row per *version* of a proposed custom script (Tier 2 connector) —
// never updated in place except the status/review columns
// on an approve/reject transition (custom-tool-repo.ts's
// reviewCustomToolVersion's atomic UPDATE...WHERE status='pending').
// `toolKey` groups a script's version history and becomes the eventual
// ToolSpec.id when an approved version is registered; `version` is a
// per-toolKey sequence starting at 1. Editing an approved version's source
// inserts a new row at status "pending" (createCustomToolVersion) — the
// prior approved row is untouched. `secretRefs` are declared secret
// *names* only (e.g. "STRIPE_API_KEY"), never bound to the `credentials`
// table at this slice — that binding needs a sandbox to inject into
//.
export const customToolProposals = pgTable(
  "custom_tool_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    toolKey: text("tool_key").notNull(),
    version: integer("version").notNull(),
    description: text("description").notNull(),
    source: text("source").notNull(),
    parametersSchema: jsonb("parameters_schema").$type<Record<string, unknown>>().notNull(),
    hostAllowList: jsonb("host_allow_list").$type<string[]>().notNull().default([]),
    secretRefs: jsonb("secret_refs").$type<string[]>().notNull().default([]),
    limits: jsonb("limits").$type<{ timeoutMs: number; memoryMb: number; maxOutputBytes: number }>().notNull(),
    // "read_only" | "reversible" | "destructive" (registry.ts's RiskClass) —
    // not imported here to keep db/schema.ts free of a dependency on
    // tools/, matching mcpServerTools.riskClass's same reasoning above.
    // The proposer's own claim — an untrusted hint, same posture as
    // mcpServerTools.serverHintRiskClass. Nothing here makes a script
    // callable; ToolSpec registration is a separate step.
    suggestedRiskClass: text("suggested_risk_class").notNull(),
    status: text("status").$type<"pending" | "approved" | "rejected">().notNull().default("pending"),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toolKeyVersionUnique: uniqueIndex("custom_tool_proposals_tool_key_version_idx").on(table.toolKey, table.version),
  }),
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personaId: uuid("persona_id"),
    jobId: uuid("job_id"),
    // Links an approval_needed row back to the tool_calls row it gates, so
    // an inline Approve/Open on a notification centre row and the
    // "resolving anywhere sets actedAt" propagation both have
    // something to key off. Nullable: only approval_needed rows set it.
    toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
    kind: text("kind").$type<NotificationKind>().notNull().default("job_finished"),
    title: text("title").notNull().default(""),
    message: text("message").notNull(),
    urgent: boolean("urgent").notNull().default(false),
    delivered: boolean("delivered").notNull().default(false),
    waitingApproval: boolean("waiting_approval").notNull().default(false),
    // Forces a push send regardless of the delivery matrix's default for
    // this row's kind. Set only by the per-chat "notify me when done"
    // override (job_attempts.notifyOnOutcome) at insert time for a
    // job_finished row -- that decision belongs to one specific job, not
    // the global preference table. Null everywhere else; a stored `false`
    // would be indistinguishable from "use the matrix," so nothing ever
    // writes one.
    pushOverride: boolean("push_override"),
    readAt: timestamp("read_at", { withTimezone: true }),
    actedAt: timestamp("acted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIndex: index("notifications_created_at_idx").on(table.createdAt, table.id),
    // The bell's badge and the popover's "Needs you" filter both read
    // exactly this shape: unread rows of the four needs-you kinds. A
    // partial index keyed on it means both queries stay index-only scans
    // regardless of how large the full table grows.
    unreadNeedsYouIndex: index("notifications_unread_needs_you_idx")
      .on(table.createdAt)
      .where(
        sql`${table.readAt} is null and ${table.kind} in ('approval_needed', 'question', 'job_failed', 'connector_broke')`,
      ),
    validKind: check(
      "notifications_kind_valid",
      sql`${table.kind} in ('approval_needed', 'question', 'job_finished', 'job_failed', 'routine_ran', 'connector_broke')`,
    ),
  }),
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    kind: text("kind").$type<NotificationKind>().primaryKey(),
    inAppEnabled: boolean("in_app_enabled").notNull(),
    pushEnabled: boolean("push_enabled").notNull(),
    digestEnabled: boolean("digest_enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    validKind: check(
      "notification_preferences_kind_valid",
      sql`${table.kind} in ('approval_needed', 'question', 'job_finished', 'job_failed', 'routine_ran', 'connector_broke')`,
    ),
  }),
);

// Single global quiet-hours window -- not per-kind, not per-device, not
// per-operator (this is a single-shared-password deployment; see
// AGENTS.md). `id` is a check-constrained singleton key (always `true`) so
// there is exactly one row, upserted in place rather than selected by an
// id a caller has to already know -- the same shape Postgres advice
// recommends for a one-row settings table.
export const notificationQuietHours = pgTable(
  "notification_quiet_hours",
  {
    id: boolean("id").primaryKey().default(true),
    enabled: boolean("enabled").notNull().default(true),
    startMinute: integer("start_minute")
      .notNull()
      .default(22 * 60),
    endMinute: integer("end_minute")
      .notNull()
      .default(7 * 60),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singleton: check("notification_quiet_hours_singleton", sql`${table.id} = true`),
    validStartMinute: check(
      "notification_quiet_hours_start_minute_valid",
      sql`${table.startMinute} >= 0 and ${table.startMinute} < 1440`,
    ),
    validEndMinute: check(
      "notification_quiet_hours_end_minute_valid",
      sql`${table.endMinute} >= 0 and ${table.endMinute} < 1440`,
    ),
  }),
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointUnique: uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
  }),
);

export type NotificationDeliveryTransport = "web_push" | "webhook";
export type NotificationDeliveryStatus = "pending" | "delivered" | "failed" | "expired";

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    transport: text("transport").$type<NotificationDeliveryTransport>().notNull(),
    pushSubscriptionId: uuid("push_subscription_id").references(() => pushSubscriptions.id, {
      onDelete: "set null",
    }),
    destination: text("destination").notNull(),
    status: text("status").$type<NotificationDeliveryStatus>().notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    destinationUnique: uniqueIndex("notification_deliveries_destination_idx").on(
      table.notificationId,
      table.transport,
      table.destination,
    ),
    validTransport: check(
      "notification_deliveries_transport_valid",
      sql`${table.transport} in ('web_push', 'webhook')`,
    ),
    validStatus: check(
      "notification_deliveries_status_valid",
      sql`${table.status} in ('pending', 'delivered', 'failed', 'expired')`,
    ),
  }),
);

// Full digest content (the durable, reviewable form) — the notify() push for
// a digest is only ever a short teaser pointing back at one of these rows.
export const digests = pgTable("digests", {
  id: uuid("id").primaryKey().defaultRandom(),
  personaId: uuid("persona_id")
    .notNull()
    .references(() => personas.id),
  routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  content: text("content").notNull(),
});

// One row per real generateText() call — "Model-call records: exact model,
// finish reason, tokens, latency, error taxonomy" from the 2026-08-22
// architecture review's missing-feature list. Written unconditionally, the
// moment the call returns (graph/persona-graph.ts's callModel -> a fresh
// onModelCall hook, wired in dispatcher.ts) — not gated behind attempt
// settlement like tool-call effects are, because the provider was already
// called (and, for a paid provider, already billed) regardless of whether
// this attempt's outcome later gets discarded by a lost lease or
// cancellation. Estimated-cost isn't captured here: that needs an
// accurate, current per-model price table this schema has no way to keep
// honest, so it's left to whoever builds that against real provider
// pricing rather than hardcoding numbers that go stale.
export const modelCalls = pgTable("model_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  personaId: uuid("persona_id")
    .notNull()
    .references(() => personas.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  // AI SDK's FinishReason ("stop" | "length" | "content-filter" | "tool-calls"
  // | "error" | "other" | "unknown"), or null when the call itself threw
  // before a finish reason was ever produced (see `error` below).
  finishReason: text("finish_reason"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  // Set only when generateText() itself threw (a provider error, a timeout,
  // an aborted signal) — the model/tokens/finishReason columns are null in
  // that case since no response ever came back to report them from.
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Durable copy of every JobEvent (orchestration/event-bus.ts) a job ever
// publishes — "Durable/replayable SSE with sequence IDs" from the
// 2026-08-22 architecture review's missing-feature list. `id` is a global
// bigserial, not a per-job counter: Postgres assigns it atomically on
// insert, so it's usable directly as an SSE `id:` / Last-Event-ID cursor
// with no separate sequence-counting logic (and no race between two
// concurrent inserts computing the same "next" number by hand).
//
// Written by JobEventBus.publish() itself (when given a db via
// setPersistence), through a per-bus serialized queue so insert order
// matches publish() call order — but fire-and-forget relative to publish()'s
// own (synchronous) callers, so a live subscriber's delivery latency is
// unaffected by the write. That makes this an *eventually* durable log, not
// a strictly gapless one: a crash in the instant between a live emit and its
// insert committing can lose that one row. stream-routes.ts's reconnect
// replay is a genuine improvement over no replay at all, not a guarantee
// that no live event handler was ever running.
export const jobEvents = pgTable(
  "job_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdIndex: index("job_events_job_id_idx").on(table.jobId, table.id),
  }),
);

export type PersonaRow = typeof personas.$inferSelect;
export type NewPersonaRow = typeof personas.$inferInsert;
export type RoutineRow = typeof routines.$inferSelect;
export type NewRoutineRow = typeof routines.$inferInsert;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type JobAttemptRow = typeof jobAttempts.$inferSelect;
export type NewJobAttemptRow = typeof jobAttempts.$inferInsert;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type NewToolCallRow = typeof toolCalls.$inferInsert;
export type PersonaStateRow = typeof personaState.$inferSelect;
export type NewPersonaStateRow = typeof personaState.$inferInsert;
export type PersonaMemoryRow = typeof personaMemories.$inferSelect;
export type NewPersonaMemoryRow = typeof personaMemories.$inferInsert;
export type CredentialRow = typeof credentials.$inferSelect;
export type NewCredentialRow = typeof credentials.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferenceRow = typeof notificationPreferences.$inferInsert;
export type NotificationQuietHoursRow = typeof notificationQuietHours.$inferSelect;
export type NewNotificationQuietHoursRow = typeof notificationQuietHours.$inferInsert;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDeliveryRow = typeof notificationDeliveries.$inferInsert;
export type DigestRow = typeof digests.$inferSelect;
export type NewDigestRow = typeof digests.$inferInsert;
export type ModelCallRow = typeof modelCalls.$inferSelect;
export type NewModelCallRow = typeof modelCalls.$inferInsert;
export type JobEventRow = typeof jobEvents.$inferSelect;
export type NewJobEventRow = typeof jobEvents.$inferInsert;
export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;
export type McpServerToolRow = typeof mcpServerTools.$inferSelect;
export type NewMcpServerToolRow = typeof mcpServerTools.$inferInsert;
export type CustomToolProposalRow = typeof customToolProposals.$inferSelect;
export type NewCustomToolProposalRow = typeof customToolProposals.$inferInsert;
export type ControlClientRow = typeof controlClients.$inferSelect;
export type NewControlClientRow = typeof controlClients.$inferInsert;
export type ControlOperationRow = typeof controlOperations.$inferSelect;
export type NewControlOperationRow = typeof controlOperations.$inferInsert;
export type ControlAuditEventRow = typeof controlAuditEvents.$inferSelect;
export type NewControlAuditEventRow = typeof controlAuditEvents.$inferInsert;
