import { createHash } from "node:crypto";
import { tool, jsonSchema, type Tool } from "ai";
import type { DrizzleDb } from "../db/client.js";
import type { JobOrigin } from "./job-origin-policy.js";

export type RiskClass = "read_only" | "reversible" | "destructive";

/**
 * Where a ToolSpec came from — the tier structure in
 * docs/adr/0002-external-tools-via-mcp-adapters.md. "native" is reviewed
 * application code shipped with this backend (builtin.ts). Materially more
 * trusted than the other three tiers because a human reviewed the exact
 * code that runs, not just approved a config or a risk-class label pointing
 * at code nobody here wrote. "mcp" is produced by approved remote MCP
 * tools; "custom_script"/"browser_agent" are declared so the field has
 * somewhere to point once those tiers exist.
 */
type ToolOrigin = "native" | "mcp" | "custom_script" | "browser_agent";

/**
 * Passed to `ToolSpec.run` for tools that need more than their own
 * arguments — DB-backed state (read_state/write_state), or which persona/job
 * this call belongs to (audit, credential scoping). Optional on `run` itself
 * so tools (and tests) that don't need it are unaffected; only
 * `buildPersonaGraph`'s caller (the dispatcher) constructs a real one, since
 * that's the only place a db/persona/job triple is actually in scope.
 */
export interface ToolContext {
  personaId: string;
  jobId: string;
  /** Stable identifier for this dispatched tool call, supplied by the graph. */
  toolCallId: string;
  db: DrizzleDb;
  signal?: AbortSignal;
  /** Attempt-owned mutation capability. Production workers fence this write. */
  writeState?: (key: string, content: string) => Promise<void>;
  /** Same fence as writeState — forget_state must not delete if the attempt later loses the lease. */
  deleteState?: (key: string) => Promise<void>;
  /** Same fence as writeState — remember/promote_memory must not persist on a cancelled or stolen attempt. */
  rememberMemory?: (entry: StagedRememberMemory) => Promise<void>;
  /** Same fence as writeState — forget_memory must not delete if the attempt later loses the lease. */
  forgetMemory?: (label: string) => Promise<void>;
}

/** Payload staged for remember/promote_memory and applied under the attempt lease. */
export interface StagedRememberMemory {
  id: string;
  personaId: string;
  label: string;
  content: string;
  sourceJobId: string | null;
  sensitivity: "normal" | "sensitive";
  importance: 0 | 1 | 2;
}

export interface ToolSpec {
  id: string;
  riskClass: RiskClass;
  /** The call crosses the database boundary and may mutate a provider. */
  externalSideEffect?: boolean;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  run: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<Record<string, unknown>>;

  // --- Provider-aware metadata (ToolSpec v2). All optional, so every
  // existing hand-written ToolSpec literal — builtin.ts and every test's
  // inline tool — keeps compiling unchanged; register() below fills
  // `origin`'s default. This is
  // deliberately a widening of the existing shape, not a new abstraction
  // alongside it: whichever tier a tool comes from, it's still one ToolSpec
  // flowing through the one dispatch node and one tool_calls audit trail
  // (persona-graph.ts's callTools) — see docs/adr/0002-external-tools-via-mcp-adapters.md.
  //
  // Deliberately NOT included, because adding the field without anything
  // behind it would be more misleading than omitting it: `health` (live
  // MCP reachability is not a ToolSpec field; disable/rediscover lives on
  // the server row), `outputSchema` (no caller validates tool output
  // against one yet), and a separate `requiresAuth` flag (MCP auth is
  // server-scoped on mcp_servers). Job-origin policy is `requiresOrigin`
  // below — that one shipped. Per-call cancellation uses the job
  // attempt AbortSignal, not a ToolSpec field.
  /** Which tier produced this tool. Unset only in tests that build a bare ToolSpec by hand; register() defaults every real registration to "native". */
  origin?: ToolOrigin;
  /** Server/provider grouping for tools that don't come one-per-file the way native tools do — an MCP server's tool catalog, or a persona-authored script's own id. Native tools leave this unset: there's exactly one "server" (this codebase). */
  namespace?: string;
  /** Freeform version or content hash. MCP tools use a deterministic discovery-content hash; Tier 2 custom scripts can use an immutable script version. */
  version?: string;
  /** Soft execution budget in milliseconds a caller may use to bound `run()`; not enforced by the registry itself — see the "not yet included" note above on cancellation. */
  timeoutMs?: number;
  /** Whether calling this tool twice with identical arguments is safe — e.g. after a crash-recovered replay. Unset/false is the conservative default: assume NOT safe to retry until a tool explicitly claims otherwise, per LangGraph's durable-execution guidance on replayed side effects (docs.langchain.com/oss/python/langgraph/functional-api). */
  idempotent?: boolean;
  /** Job origins allowed to call this tool — enforced centrally by job-origin-policy.ts's originAllowsTool, consulted from persona-graph.ts's callTools. Unset/empty means callable from any origin (today's behavior for every existing tool); Tier 2 (custom_script) and Tier 3 (browser_agent) tools are expected to set this to `["user"]` so a cron or delegated job can't trigger them. */
  requiresOrigin?: JobOrigin[];
}

type JsonSchemaValue = string | number | boolean | null | JsonSchemaValue[] | JsonSchemaObject;
interface JsonSchemaObject {
  [key: string]: JsonSchemaValue;
}

const SUPPORTED_STRICT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "description",
  "enum",
  "anyOf",
  "$defs",
  "definitions",
  "$ref",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "minItems",
  "maxItems",
  "pattern",
  "format",
]);

const SUPPORTED_STRICT_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

function permitsNull(schema: JsonSchemaObject): boolean {
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return (
    Array.isArray(schema.anyOf) &&
    schema.anyOf.some((branch) => {
      return branch !== null && typeof branch === "object" && !Array.isArray(branch) && permitsNull(branch);
    })
  );
}

function makeNullable(schema: JsonSchemaObject): JsonSchemaObject {
  if (permitsNull(schema)) return schema;
  const type = schema.type;
  if (typeof type === "string") {
    const nullable: JsonSchemaObject = { ...schema, type: [type, "null"] };
    if (Array.isArray(nullable.enum) && !nullable.enum.includes(null)) nullable.enum = [...nullable.enum, null];
    return nullable;
  }
  if (Array.isArray(type)) {
    const nullable: JsonSchemaObject = { ...schema, type: [...type, "null"] };
    if (Array.isArray(nullable.enum) && !nullable.enum.includes(null)) nullable.enum = [...nullable.enum, null];
    return nullable;
  }
  return { anyOf: [schema, { type: "null" }] };
}

function isSchemaObject(value: JsonSchemaValue): value is JsonSchemaObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExplicitType(schema: JsonSchemaObject): boolean {
  return typeof schema.type === "string" || (Array.isArray(schema.type) && schema.type.length > 0);
}

function includesType(schema: JsonSchemaObject, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

// OpenAI strict function schemas have no "any" type. MCP tools routinely
// emit JSON Schema's unconstrained `{}` (Python `List[List]` / `Any`) as
// array items; the provider then 400s with "schema must have a 'type' key"
// at that node. A closed scalar union is the representable subset — nested
// objects and arrays still need a real shape, which is the same limit as
// additionalProperties: false on objects.
function unconstrainedJsonValue(): JsonSchemaObject {
  return { type: ["boolean", "null", "number", "string"] };
}

function jsonTypeOf(value: JsonSchemaValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  return "object";
}

function schemaAsObject(value: JsonSchemaValue): JsonSchemaObject {
  return isSchemaObject(value) ? value : unconstrainedJsonValue();
}

// Tuple `items` (an array of schemas) is valid JSON Schema and shows up in
// MCP catalogs, but OpenAI strict mode only accepts a single items schema.
function normalizeArrayItems(schema: JsonSchemaObject): void {
  const isArray = includesType(schema, "array");
  if (schema.items === true || (isArray && (schema.items === undefined || schema.items === null))) {
    schema.items = unconstrainedJsonValue();
    return;
  }
  if (!Array.isArray(schema.items)) return;
  const variants = schema.items.filter(isSchemaObject);
  const [first, ...rest] = variants;
  schema.items = first === undefined ? unconstrainedJsonValue() : rest.length === 0 ? first : { anyOf: variants };
}

function ensureSchemaType(schema: JsonSchemaObject): void {
  if (hasExplicitType(schema)) return;
  // Combinator / $ref nodes are themselves the type information; adding a
  // sibling type would narrow the union the catalog actually declared.
  if (Array.isArray(schema.anyOf) || typeof schema.$ref === "string") return;
  if (schema.items !== undefined) {
    schema.type = "array";
    return;
  }
  if (typeof schema.pattern === "string" || typeof schema.format === "string") {
    schema.type = "string";
    return;
  }
  if (
    typeof schema.minimum === "number" ||
    typeof schema.maximum === "number" ||
    typeof schema.exclusiveMinimum === "number" ||
    typeof schema.exclusiveMaximum === "number" ||
    typeof schema.multipleOf === "number"
  ) {
    schema.type = "number";
    return;
  }
  if (typeof schema.minItems === "number" || typeof schema.maxItems === "number") {
    schema.type = "array";
    return;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = [...new Set(schema.enum.map(jsonTypeOf))];
    const [only] = types;
    schema.type = only !== undefined && types.length === 1 ? only : types;
    return;
  }
  Object.assign(schema, unconstrainedJsonValue());
}

function compileStrictSchema(value: JsonSchemaObject): JsonSchemaObject;
function compileStrictSchema(value: JsonSchemaValue): JsonSchemaValue;
function compileStrictSchema(value: JsonSchemaValue): JsonSchemaValue {
  if (Array.isArray(value)) return value.map(compileStrictSchema);
  if (value === null || typeof value !== "object") return value;

  // OpenAI strict mode accepts anyOf, but not oneOf/allOf. Widening those
  // composition keywords is suitable for provider guidance; the source
  // schema remains authoritative at the actual tool boundary.
  const entries = Object.entries(value)
    .filter(([key]) => SUPPORTED_STRICT_KEYWORDS.has(key) || key === "oneOf" || key === "allOf")
    .map(([key, item]) => {
      const providerKey = key === "oneOf" || key === "allOf" ? "anyOf" : key;
      const isSchemaMap = key === "properties" || key === "$defs" || key === "definitions";
      if (isSchemaMap && item !== null && typeof item === "object" && !Array.isArray(item)) {
        // SAFETY: schema maps have arbitrary names as keys and schemas as
        // values; the enclosing keyword, not those user-defined names, is
        // what the strict-keyword allowlist applies to.
        const schemas = Object.fromEntries(
          Object.entries(item).map(([name, schema]) => [name, compileStrictSchema(schema)]),
        ) as JsonSchemaObject;
        return [providerKey, schemas];
      }
      return [providerKey, compileStrictSchema(item)];
    });
  // SAFETY: every entry remains inside the recursive JSON-value domain.
  const compiled = Object.fromEntries(entries) as JsonSchemaObject;
  delete compiled.nullable;
  if (typeof compiled.format !== "string" || !SUPPORTED_STRICT_FORMATS.has(compiled.format)) delete compiled.format;

  const isObject =
    compiled.type === "object" ||
    (Array.isArray(compiled.type) && compiled.type.includes("object")) ||
    (compiled.properties !== null && typeof compiled.properties === "object" && !Array.isArray(compiled.properties));
  if (isObject) {
    const properties =
      compiled.properties !== null && typeof compiled.properties === "object" && !Array.isArray(compiled.properties)
        ? compiled.properties
        : {};
    const sourceRequired = new Set(
      Array.isArray(value.required) ? value.required.filter((key): key is string => typeof key === "string") : [],
    );
    // SAFETY: properties was narrowed to a JSON object above, and every
    // mapped value is another JsonSchemaObject.
    const strictProperties = Object.fromEntries(
      Object.entries(properties).map(([key, property]) => {
        const propertySchema = schemaAsObject(property);
        return [key, sourceRequired.has(key) ? propertySchema : makeNullable(propertySchema)];
      }),
    ) as JsonSchemaObject;
    compiled.type ??= "object";
    compiled.properties = strictProperties;
    compiled.required = Object.keys(strictProperties);
    compiled.additionalProperties = false;
  }
  normalizeArrayItems(compiled);
  ensureSchemaType(compiled);
  // Inferring `type: "array"` (minItems, items-without-type, etc.) happens
  // after the first normalize pass; run it again so those nodes get `items`.
  normalizeArrayItems(compiled);
  return value.nullable === true ? makeNullable(compiled) : compiled;
}

function executionValue(schema: JsonSchemaObject, value: JsonSchemaValue): JsonSchemaValue {
  if (Array.isArray(value)) {
    const items = schema.items;
    if (items !== null && typeof items === "object" && !Array.isArray(items)) {
      return value.map((item) => executionValue(items, item));
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return value;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [],
  );
  // SAFETY: value and every recursively normalized entry stay within the
  // JsonSchemaValue domain.
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const property = properties[key];
      if (item === null && !required.has(key)) return [];
      if (property !== null && typeof property === "object" && !Array.isArray(property)) {
        return [[key, executionValue(property, item)]];
      }
      return [[key, item]];
    }),
  ) as JsonSchemaObject;
}

export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();
  private modelNameToId = new Map<string, string>();
  private idToModelName = new Map<string, string>();

  private allocateModelName(id: string): string {
    const safeAsIs = /^[A-Za-z0-9_-]{1,64}$/.test(id);
    const digest = createHash("sha256").update(id).digest("hex");
    const readablePart = (id.split(":").at(-1) ?? id).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    const suffix = digest.slice(0, 16);
    const readableCandidate = readablePart
      ? `${readablePart.slice(0, 64 - suffix.length - 1)}_${suffix}`
      : `tool_${digest.slice(0, 32)}`;
    const candidates = safeAsIs
      ? [id, readableCandidate, `tool_${digest.slice(0, 32)}`]
      : [readableCandidate, `tool_${digest.slice(0, 32)}`];
    candidates.push(`t_${digest.slice(0, 62)}`);
    for (const candidate of candidates) {
      const owner = this.modelNameToId.get(candidate);
      if (!owner || owner === id) return candidate;
    }
    throw new Error(`could not allocate a collision-free provider tool name for ${id}`);
  }

  register(spec: ToolSpec): void {
    const previousName = this.idToModelName.get(spec.id);
    if (previousName) this.modelNameToId.delete(previousName);
    const modelName = this.allocateModelName(spec.id);
    this.tools.set(spec.id, { ...spec, origin: spec.origin ?? "native" });
    this.idToModelName.set(spec.id, modelName);
    this.modelNameToId.set(modelName, spec.id);
  }

  get(id: string): ToolSpec {
    const spec = this.tools.get(id);
    if (!spec) throw new Error(`unknown tool: ${id}`);
    return spec;
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /** Resolve the provider-safe name emitted by aiSdkToolsFor back to the
   * canonical registry id used by approval, audit, and execution. */
  resolveModelTool(modelName: string): ToolSpec {
    const id = this.modelNameToId.get(modelName) ?? modelName;
    return this.get(id);
  }

  /** Same lookup as resolveModelTool, but returns undefined instead of
   *  throwing when the alias no longer maps to a registered tool — e.g. an
   *  MCP tool revoked or a server deleted between when the model was given
   *  its tool list and when this call is dispatched (including across a
   *  paused/resumed job). Callers that need to degrade a stale tool call
   *  into a normal tool-error result rather than crashing the whole turn
   *  (persona-graph.ts's callTools) should use this instead of
   *  resolveModelTool. */
  tryResolveModelTool(modelName: string): ToolSpec | undefined {
    const id = this.modelNameToId.get(modelName) ?? modelName;
    return this.tools.get(id);
  }

  /** Undo the null placeholders OpenAI strict mode uses to represent fields
   * that are optional in the tool's source schema. */
  executionArgumentsFor(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
    // SAFETY: ToolSpec parameters and model tool arguments both cross JSON
    // boundaries; their public types are wider only for caller ergonomics.
    return executionValue(spec.parameters as JsonSchemaObject, args as JsonSchemaObject) as Record<string, unknown>;
  }

  /** Removes one tool by id. Small addition for Tier 1's DELETE /mcp/servers/:id —
   *  a deleted MCP server's tools must stop being callable, not linger in the
   *  registry with a now-nonexistent DB row behind them. No-op if the id isn't registered. */
  unregister(id: string): void {
    this.tools.delete(id);
    const modelName = this.idToModelName.get(id);
    if (modelName) this.modelNameToId.delete(modelName);
    this.idToModelName.delete(id);
  }

  /** Removes every tool whose `namespace` matches — the whole-server
   *  equivalent of `unregister`, since an MCP server's tools all share its
   *  serverId as `namespace` (see mcp-registration.ts). */
  unregisterNamespace(namespace: string): void {
    for (const [id, spec] of this.tools) {
      if (spec.namespace === namespace) this.unregister(id);
    }
  }

  /** No `execute` on purpose — the app's own tool-dispatch graph node runs tools, so the
   *  destructive-tool interrupt gate stays enforced there, not inside the model call. */
  aiSdkToolsFor(ids: string[]) {
    const out: Record<string, Tool> = {};
    for (const id of ids) {
      const spec = this.tools.get(id);
      if (!spec) continue;
      const modelName = this.idToModelName.get(id);
      if (!modelName) continue;
      // SAFETY: ToolSpec.parameters is the registry's JSON Schema field. All
      // production writers supply JSON values (native literals or Postgres
      // jsonb); the assertion narrows that established storage contract for
      // the provider-specific recursive transform.
      const parameters = compileStrictSchema(spec.parameters as JsonSchemaObject);
      // SAFETY: parameters remains a JSON object after recursively compiling
      // its nested schemas; JSONSchema7 accepts that object at the same
      // boundary the pre-normalized ToolSpec used.
      const providerParameters = parameters as Record<string, unknown>;
      out[modelName] = tool({
        description: spec.description,
        inputSchema: jsonSchema(providerParameters),
      });
    }
    return out;
  }
}

export const defaultRegistry = new ToolRegistry();
