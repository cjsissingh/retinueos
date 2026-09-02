import type { RiskClass } from "./api-client";
import { displayToolName } from "./display";

/**
 * Frontend-only renderer registry, keyed on the same `toolId` the backend
 * already sends on every tool call. Turns a raw arguments blob into a title
 * plus an ordered list of label/value pairs, so Approvals and the job
 * transcript never have to fall back to `JSON.stringify`. No backend change
 * needed to add an entry here.
 */
interface ToolField {
  label: string;
  value: string;
}

export interface ToolRenderer {
  title: string;
  /** Fallback risk class if the tool call itself doesn't carry one. */
  riskClass: RiskClass;
  fields: (args: Record<string, unknown>) => ToolField[];
}

// `v` is a tool-call argument value, whose shape is per-tool and genuinely
// unknown here (see REGISTRY above) -- this exists specifically to safely
// render any of them.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function str(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// `Record<string, ToolRenderer>` (not `satisfies`) is deliberate: getToolRenderer
// below looks this up by an arbitrary `toolId` string and falls back to a
// default for one it doesn't recognize -- narrowing the key type to this
// registry's current literal keys would make that open-ended lookup a type
// error, not a widening.
// oxlint-disable-next-line anti-slop/no-known-value-widening
const REGISTRY: Record<string, ToolRenderer> = {
  send_email: {
    title: "Send an email",
    riskClass: "destructive",
    fields: (args) => [
      { label: "To", value: str(args.to) },
      { label: "Subject", value: str(args.subject) },
      { label: "Body", value: str(args.body) },
    ],
  },
  get_weather: {
    title: "Check the weather",
    riskClass: "read_only",
    fields: (args) => [{ label: "City", value: str(args.city) }],
  },
  delegate_to: {
    title: "Delegate to another persona",
    riskClass: "reversible",
    fields: (args) => [
      { label: "Persona", value: str(args.personaId) },
      { label: "Task", value: str(args.task) },
    ],
  },
  read_state: {
    title: "Read own notes",
    riskClass: "read_only",
    fields: (args) => [{ label: "Key", value: str(args.key) }],
  },
  write_state: {
    title: "Write own notes",
    riskClass: "reversible",
    fields: (args) => [
      { label: "Key", value: str(args.key) },
      { label: "Content", value: str(args.content) },
    ],
  },
  gmail_search: {
    title: "Search Gmail",
    riskClass: "read_only",
    fields: (args) => [{ label: "Query", value: str(args.query) }],
  },
  gmail_label: {
    title: "Label an email",
    riskClass: "reversible",
    fields: (args) => [
      { label: "Message", value: str(args.messageId) },
      { label: "Label", value: str(args.label) },
      { label: "Remove", value: args.remove ? "yes" : "no" },
    ],
  },
  gmail_draft_reply: {
    title: "Draft an email reply",
    riskClass: "reversible",
    fields: (args) => [
      { label: "To", value: str(args.to) },
      { label: "Subject", value: str(args.subject) },
      { label: "Body", value: str(args.body) },
    ],
  },
  calendar_create_event: {
    title: "Create a calendar event",
    riskClass: "reversible",
    fields: (args) => [
      { label: "Title", value: str(args.title) },
      { label: "Start", value: str(args.startTime) },
      { label: "End", value: str(args.endTime) },
    ],
  },
};

export function getToolRenderer(toolId: string): ToolRenderer {
  return (
    REGISTRY[toolId] ?? {
      title: displayToolName(toolId),
      // Unknown tools are treated as destructive until classified — see
      // the look & feel spec's tool renderer registry section.
      riskClass: "destructive",
      fields: (args) => Object.entries(args).map(([label, value]) => ({ label, value: str(value) })),
    }
  );
}
