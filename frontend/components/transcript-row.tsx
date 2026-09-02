import { getToolRenderer } from "@/lib/tool-renderers";
import { RiskFrame, RiskBadge } from "./risk-frame";
import { MarkdownContent } from "./markdown-content";
import { TechnicalDetails } from "./technical-details";
import { displayEnum } from "@/lib/display";

// Shared by /logs/[jobId] (a single job's own live view) and the persona
// chat page (a running job embedded inline in its chat) -- both drive this
// off the same SSE event shape (see lib/use-job-transcript.ts), so the
// rendering for it lives in one place instead of two copies drifting apart.
export interface TranscriptEntry {
  key: string;
  kind: "status" | "model_end" | "tool_call" | "tool_result" | "delegation_start" | "delegation_end" | "unknown";
  at: number;
  data: Record<string, unknown>;
}

// Tool result values are opaque JobEvent wire data, so this narrows the
// scalar values that are safe to show in the compact transcript summary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function conciseText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

// Tool payload objects are untyped JobEvent data, so this checks the only
// object shape needed before reading whitelisted result fields.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isToolResultRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Native tools return scalar `content`; MCP tools return a list of typed
// content blocks. Only text blocks are safe and useful in the compact row.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function conciseContent(value: unknown): string | null {
  const direct = conciseText(value);
  if (direct) return direct;
  if (!Array.isArray(value)) return null;

  for (const block of value) {
    if (!isToolResultRecord(block) || block.type !== "text") continue;
    const text = conciseText(block.text);
    if (text) return text;
  }
  return null;
}

// Results are untyped tool output by design; only explicitly selected scalar
// fields may appear outside the technical-details disclosure.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function conciseResultSummary(result: unknown): string | null {
  const direct = conciseText(result);
  if (direct) return direct;
  if (!isToolResultRecord(result)) return null;

  for (const key of ["summary", "message"]) {
    const value = conciseText(result[key]);
    if (value) return value;
  }
  const content = conciseContent(result.content);
  if (content) return content;
  const status = conciseText(result.status);
  if (status) return status;
  return null;
}

// Tool result values remain opaque until conciseResultSummary narrows them.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function conciseToolSummary(fields: ReturnType<ReturnType<typeof getToolRenderer>["fields"]>, result: unknown): string {
  const resultSummary = conciseResultSummary(result);
  if (resultSummary) {
    const abbreviated = resultSummary.replace(/\s+/g, " ").slice(0, 120);
    return `${abbreviated}${abbreviated.length < resultSummary.length ? "…" : ""}`;
  }

  for (const field of fields) {
    const value = field.value.trim();
    if (!value || value === "—" || value.startsWith("{") || value.startsWith("[")) continue;
    const abbreviated = value.replace(/\s+/g, " ").slice(0, 120);
    return `${field.label}: ${abbreviated}${abbreviated.length < value.length ? "…" : ""}`;
  }
  return "Details available.";
}

function technicalToolData(data: Record<string, unknown>) {
  return {
    arguments: data.arguments ?? {},
    result: data.result ?? {},
  };
}

export function TranscriptRow({ entry, framed = true }: { entry: TranscriptEntry; framed?: boolean }) {
  if (entry.kind === "model_end") {
    const content = typeof entry.data.content === "string" ? entry.data.content : null;
    if (!content) return null;
    return <MarkdownContent content={content} className="text-sm" />;
  }

  if (entry.kind === "tool_call" || entry.kind === "tool_result") {
    const toolId = typeof entry.data.toolId === "string" ? entry.data.toolId : "unknown_tool";
    const renderer = getToolRenderer(toolId);
    // SAFETY: `entry.data` is already Record<string, unknown> (this same
    // JobEvent wire format, per the SAFETY comments above); `??`-chaining
    // through its `.arguments`/`.result` fields just loses that annotation
    // along the way, not the underlying contract.
    const args = (entry.data.arguments ?? entry.data.result ?? {}) as Record<string, unknown>;
    const fields = renderer.fields(args);
    return (
      <RiskFrame riskClass={renderer.riskClass} framed={framed} className="min-w-0 max-w-full">
        <div className="min-w-0 max-w-full p-3.5">
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="m-0 break-words font-sans text-[13px] font-medium text-fg">{renderer.title}</p>
              <p className="m-0 truncate font-sans text-xs text-fg-muted">
                {conciseToolSummary(fields, entry.data.result)}
              </p>
            </div>
            <RiskBadge riskClass={renderer.riskClass} />
            {entry.kind === "tool_call" && (
              <span className="flex-none font-mono text-xs text-fg-faint">awaiting you</span>
            )}
          </div>
          <TechnicalDetails>
            <pre className="m-0 mt-2 max-w-full whitespace-pre-wrap break-all rounded-button bg-[var(--accent-soft)] p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
              {JSON.stringify(technicalToolData(entry.data), null, 2)}
            </pre>
          </TechnicalDetails>
        </div>
      </RiskFrame>
    );
  }

  if (entry.kind === "status") {
    const status = typeof entry.data.status === "string" ? entry.data.status : "unknown";
    return <p className="m-0 font-sans text-xs text-fg-faint">Status · {displayEnum(status)}</p>;
  }

  if (entry.kind === "delegation_start") {
    const task = typeof entry.data.task === "string" ? entry.data.task : "";
    return <p className="m-0 font-mono text-xs text-fg-faint">delegating: {task}</p>;
  }

  if (entry.kind === "delegation_end") {
    const status = typeof entry.data.status === "string" ? entry.data.status : "unknown";
    return <p className="m-0 font-sans text-xs text-fg-faint">Delegation finished · {displayEnum(status)}</p>;
  }

  return null;
}
