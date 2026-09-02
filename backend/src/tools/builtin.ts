import { ToolRegistry, ToolSpec } from "./registry.js";
import { RoutineService } from "../control/routine-service.js";
import { readState, writeState } from "../personas/persona-state-repo.js";
import {
  listStateTool,
  forgetStateTool,
  rememberTool,
  recallTool,
  forgetMemoryTool,
  promoteMemoryTool,
} from "./memory-tools.js";
import { routineToolSpecs } from "./routine-tools.js";
import { createWebSearchTool } from "./web-search.js";

const getWeather: ToolSpec = {
  id: "get_weather",
  riskClass: "read_only",
  description: "Get current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  run: async (args) => ({ city: args.city ?? "unknown", temperature: 68, conditions: "clear" }),
};

const sendEmail: ToolSpec = {
  id: "send_email",
  riskClass: "destructive",
  externalSideEffect: true,
  description: "Send an email on the user's behalf.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["to", "subject", "body"],
  },
  // Mocked for MVP — no real send. Destructive risk_class means this only runs
  // after explicit approval resumes the interrupted graph (Tasks 5/7/9).
  run: async (args, ctx) => {
    ctx?.signal?.throwIfAborted();
    return { sentTo: args.to, status: "mock-sent" };
  },
};

const delegateTo: ToolSpec = {
  id: "delegate_to",
  riskClass: "reversible",
  description: "Delegate a task to another persona by UUID, exact name, or name-based slug.",
  parameters: {
    type: "object",
    properties: {
      personaId: {
        type: "string",
        description: "The target persona's UUID, exact name, or name-based slug (for example, research-lead).",
      },
      task: { type: "string" },
    },
    required: ["personaId", "task"],
  },
  // The dispatcher intercepts "delegate_to" calls before generic tool dispatch
  // (see persona-graph.ts's onDelegate callback) because delegation needs DB
  // access this function doesn't have. This body only runs if that
  // interception is ever bypassed, so it fails loudly instead of silently
  // pretending to delegate.
  run: async () => {
    throw new Error("delegate_to must be handled by the dispatcher's onDelegate callback, not executed directly");
  },
};

// read_state/write_state manage persona-owned state directly (see
// docs/adr/0003-three-memory-stores.md). Writes replace a key's content but
// do not cause an external side effect, so they are reversible rather than
// destructive and a trusted persona can maintain ongoing state without an
// approval interruption.
const readStateTool: ToolSpec = {
  id: "read_state",
  riskClass: "read_only",
  description:
    "Read back a piece of your own persisted state by key (e.g. 'inbox-suggestions', 'deliveries'). " +
    "Returns an empty string if nothing has been written under this key yet.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
  run: async (args, ctx) => {
    if (!ctx)
      throw new Error("read_state requires tool context (personaId, db) — not available in this execution path");
    // SAFETY: the AI SDK validates tool-call arguments against this tool's
    // own `parameters` JSON Schema (key: string required) before `run` is
    // ever invoked.
    const content = await readState(ctx.db, ctx.personaId, args.key as string);
    return { key: args.key, content };
  },
};

const writeStateTool: ToolSpec = {
  id: "write_state",
  riskClass: "reversible",
  description:
    "Overwrite a piece of your own persisted state by key, wholesale — the whole content, not a diff. " +
    "Use this to track things across runs (a delivery, a pending item, a suggestion awaiting review).",
  parameters: {
    type: "object",
    properties: { key: { type: "string" }, content: { type: "string" } },
    required: ["key", "content"],
  },
  run: async (args, ctx) => {
    if (!ctx)
      throw new Error("write_state requires tool context (personaId, db) — not available in this execution path");
    // SAFETY: the AI SDK validates tool-call arguments against this tool's
    // own `parameters` JSON Schema (key/content: string required) before
    // `run` is ever invoked.
    const { key, content } = args as { key: string; content: string };
    if (ctx.writeState) {
      await ctx.writeState(key, content);
    } else {
      // Compatibility for direct dispatcher/tests. Production JobWorker
      // always provides the attempt-fenced mutation capability.
      await writeState(ctx.db, ctx.personaId, key, content);
    }
    return { key: args.key, status: "written" };
  },
};

export function registerBuiltinTools(
  registry: ToolRegistry,
  dependencies: { routineService: RoutineService; webSearchApiKey?: string },
): void {
  const tools = [
    getWeather,
    sendEmail,
    delegateTo,
    readStateTool,
    writeStateTool,
    listStateTool,
    forgetStateTool,
    rememberTool,
    recallTool,
    forgetMemoryTool,
    promoteMemoryTool,
    ...(dependencies.webSearchApiKey?.trim() ? [createWebSearchTool(dependencies.webSearchApiKey.trim())] : []),
    ...routineToolSpecs(dependencies.routineService),
  ];
  for (const tool of tools) registry.register(tool);
}

// Gmail/Calendar used to be hand-coded native tools here. Retired once
// remote MCP covered the same capability — point RetinueOS at a
// Gmail/Calendar MCP server via /settings/mcp instead. See
// docs/adr/0002-external-tools-via-mcp-adapters.md and docs/CONNECTORS.md.
// Browser-automation tools (LinkedIn, bookings) and the Actual Budget CLI
// remain explicitly deferred.
