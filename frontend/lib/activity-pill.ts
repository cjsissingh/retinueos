import type { Job, Message, ToolCall } from "./api-client";
import { getToolRenderer } from "./tool-renderers";
import type { TranscriptEntry } from "@/components/transcript-row";

// The persona chat page's merged history -- messages, tool calls, and
// delegations interleaved by when each happened (see the page's own comment
// on `TimelineEntry`). Lives here, not in the page, so `groupTimelineForPills`
// below can be unit tested without the page's client-component runtime --
// same seam as lib/chat-list.ts and lib/chat-title.ts.
export type TimelineEntry =
  | { kind: "message"; at: string; message: Message }
  | { kind: "tool_call"; at: string; toolCall: ToolCall }
  | { kind: "delegation"; at: string; job: Job };

// A run of consecutive, successful tool calls collapsed into one row
//. "Consecutive" is over the existing TimelineEntry merge, i.e. a
// run breaks at the next message or delegation -- there's no real "turn" id
// on the wire to group by instead.
export interface ActivityPill {
  kind: "activity_pill";
  key: string;
  at: string;
  connector: string;
  summary: string;
  count: number;
  calls: ToolCall[];
}

export type GroupedEntry = TimelineEntry | ActivityPill;

// A failed call is the one outcome in a run worth stopping for -- it stays
// its own row, in the danger frame, rather than hiding inside a pill's
// "N calls" count.
function isCollapsible(toolCall: ToolCall): boolean {
  return toolCall.status !== "failed";
}

// MCP tool ids are "connector.verb" (`gmail.send_message`); native tools
// (`send_email`, `get_weather`, ...) carry no connector at all.
function connectorOf(toolId: string): string {
  const dot = toolId.indexOf(".");
  return dot === -1 ? "tools" : toolId.slice(0, dot);
}

function buildPill(run: { kind: "tool_call"; at: string; toolCall: ToolCall }[]): ActivityPill {
  const first = run[0];
  const connector = connectorOf(first.toolCall.toolId);
  const sameConnector = run.every((entry) => connectorOf(entry.toolCall.toolId) === connector);

  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const entry of run) {
    const label = getToolRenderer(entry.toolCall.toolId).title.toLowerCase();
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = order.map((label) => (counts.get(label)! > 1 ? `${label} ×${counts.get(label)}` : label)).join(", ");

  return {
    kind: "activity_pill",
    key: `pill-${first.toolCall.id}`,
    at: first.at,
    connector: sameConnector ? connector : "tools",
    summary,
    count: run.length,
    calls: run.map((entry) => entry.toolCall),
  };
}

/** Merges consecutive, non-failed `tool_call` entries into one `ActivityPill`
 *  each; everything else (messages, delegations, and failed tool calls)
 *  passes through unchanged. A lone tool call stays a plain entry -- there's
 *  nothing to merge with, so a pill of one would just be a worse row. */
export function groupTimelineForPills(entries: TimelineEntry[]): GroupedEntry[] {
  const grouped: GroupedEntry[] = [];
  let run: { kind: "tool_call"; at: string; toolCall: ToolCall }[] = [];

  function flushRun() {
    if (run.length === 0) return;
    grouped.push(run.length === 1 ? run[0] : buildPill(run));
    run = [];
  }

  for (const entry of entries) {
    if (entry.kind === "tool_call" && isCollapsible(entry.toolCall)) {
      run.push(entry);
      continue;
    }
    flushRun();
    grouped.push(entry);
  }
  flushRun();
  return grouped;
}

/** The same `TranscriptRow` shape the page already builds for a single tool
 *  call (the "no data removed" requirement) -- shared so an expanded
 *  pill and a standalone tool-call row render identically. */
export function toolCallTranscriptEntry(toolCall: ToolCall): TranscriptEntry {
  return {
    key: toolCall.id,
    kind: "tool_result",
    at: new Date(toolCall.createdAt).getTime(),
    data: {
      toolId: toolCall.toolId,
      arguments: toolCall.arguments,
      result: toolCall.result ?? {},
    },
  };
}
