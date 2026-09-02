import Link from "next/link";
import type { Job, Message, Persona, ToolCall } from "@/lib/api-client";
import { displayEnum, displayModelName, shortId } from "@/lib/display";
import { getToolRenderer } from "@/lib/tool-renderers";
import { PAGE_PAD } from "@/lib/touch-layout";
import { MarkdownContent } from "./markdown-content";
import { PageHeader } from "./page-header";
import { PersonaAvatar } from "./persona-avatar";
import { RiskBadge } from "./risk-frame";
import { JobStatusBadge } from "./status-badge";
import { TechnicalDetails } from "./technical-details";
import { TranscriptRow, type TranscriptEntry } from "./transcript-row";

const ORIGIN_LABEL = {
  user: "Asked directly",
  cron: "Scheduled run",
  delegation: "Delegated task",
} satisfies Record<Job["origin"], string>;

function messageTime(createdAt: string) {
  return new Date(createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ConversationMessage({ message, persona }: { message: Message; persona: Persona | null }) {
  if (message.role === "user") {
    return (
      <div className="flex min-w-0 max-w-full justify-end">
        <div className="flex min-w-0 max-w-[90%] flex-col items-end gap-1 sm:max-w-[72%]">
          <div
            className="max-w-full whitespace-pre-wrap break-words rounded-button border px-4 py-3 font-sans text-[15px] leading-relaxed text-fg"
            style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)" }}
          >
            {message.content}
          </div>
          <span className="font-mono text-[11px] text-fg-faint">{messageTime(message.createdAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full gap-3">
      {persona && <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />}
      <div className="min-w-0 max-w-[760px] flex-1">
        <MarkdownContent content={message.content} className="text-[15px]" />
        <span className="mt-1 block font-mono text-[11px] text-fg-faint">{messageTime(message.createdAt)}</span>
      </div>
    </div>
  );
}

export function JobDetailView({
  job,
  persona,
  messages,
  toolCalls,
  transcript,
}: {
  job: Job;
  persona: Persona | null;
  messages: Message[];
  toolCalls: ToolCall[];
  transcript: TranscriptEntry[];
}) {
  const request = job.prompt ?? messages.find((message) => message.role === "user")?.content ?? null;
  const firstMessageIsRequest = Boolean(request && messages[0]?.role === "user" && messages[0].content === request);
  const conversation = firstMessageIsRequest ? messages.slice(1) : messages;
  const isTerminal = ["done", "failed", "cancelled", "timed_out", "outcome_unknown"].includes(job.status);
  const failed = ["failed", "cancelled", "timed_out", "outcome_unknown"].includes(job.status);

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={`${ORIGIN_LABEL[job.origin]} · Job ${shortId(job.id)}`}
        title="Job details"
        description={`Created ${new Date(job.createdAt).toLocaleString()}`}
        backHref="/logs"
        actions={
          <>
            <JobStatusBadge status={job.status} />
            {persona && (
              <Link
                href={`/roster/${persona.id}`}
                className="flex items-center gap-2 font-sans text-[13px] text-fg-muted no-underline"
              >
                <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
                {persona.name}
              </Link>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(260px,0.72fr)]">
        <div className="flex min-w-0 flex-col gap-8">
          {failed && (
            <section aria-labelledby="failure-heading">
              <h2 id="failure-heading" className="sr-only">
                Failure
              </h2>
              <p
                className="m-0 rounded-button border px-4 py-3 font-mono text-[13px] leading-relaxed"
                style={{ borderColor: "var(--danger)", background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {job.error ?? "This job stopped without a recorded reason."}
              </p>
            </section>
          )}

          <section className="min-w-0 border-t pt-4" aria-labelledby="request-heading">
            <h2 id="request-heading" className="m-0 mb-4 font-serif text-xl text-fg">
              Request
            </h2>
            {request ? (
              <p className="m-0 whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-fg">
                {request}
              </p>
            ) : (
              <p className="m-0 font-sans text-sm text-fg-muted">The original request was not recorded.</p>
            )}
          </section>

          <section className="min-w-0 border-t pt-4" aria-labelledby="conversation-heading">
            <h2 id="conversation-heading" className="m-0 mb-5 font-serif text-xl text-fg">
              Conversation
            </h2>
            <div className="flex min-w-0 flex-col gap-5">
              {conversation.length === 0 && transcript.length === 0 && (
                <p className="m-0 font-sans text-sm text-fg-muted">
                  {isTerminal
                    ? "No response was recorded. Tool calls, if any, remain available in the audit sidebar."
                    : "Watching for activity…"}
                </p>
              )}
              {conversation.map((message) => (
                <ConversationMessage key={message.id} message={message} persona={persona} />
              ))}
              {transcript.map((entry) => (
                <TranscriptRow key={entry.key} entry={entry} />
              ))}
            </div>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-5 border-t pt-4">
          <section>
            <h2 className="m-0 mb-3 font-serif text-xl text-fg">Overview</h2>
            <div className="flex flex-col gap-2.5 font-sans text-[13px]">
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Status</span>
                <span className="text-fg">{displayEnum(job.status)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Created</span>
                <code className="font-mono text-xs text-fg-faint">{new Date(job.createdAt).toLocaleTimeString()}</code>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Updated</span>
                <code className="font-mono text-xs text-fg-faint">{new Date(job.updatedAt).toLocaleTimeString()}</code>
              </div>
            </div>
          </section>

          <TechnicalDetails className="border-t border-border">
            <div className="flex flex-col gap-2 rounded-button bg-surface-sunken p-3 font-sans text-[13px]">
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Job</span>
                <code className="truncate font-mono text-xs text-fg">{job.id}</code>
              </div>
              {persona && (
                <div className="flex justify-between gap-3">
                  <span className="text-fg-muted">Model</span>
                  <span className="text-right text-fg">
                    {displayModelName(persona.modelProvider, persona.modelName)}
                    <code className="block font-mono text-[10px] text-fg-faint">
                      {persona.modelProvider}/{persona.modelName}
                    </code>
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Trigger</span>
                <span className="text-fg">{displayEnum(job.origin)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Depth</span>
                <span className="text-fg">{job.depth}</span>
              </div>
              {job.parentJobId && (
                <div className="flex justify-between gap-3">
                  <span className="text-fg-muted">Parent</span>
                  <Link href={`/logs/${job.parentJobId}`} className="font-mono text-xs">
                    {job.parentJobId.slice(0, 8)}
                  </Link>
                </div>
              )}
            </div>
          </TechnicalDetails>

          {toolCalls.length > 0 && (
            <section className="border-t pt-4">
              <h2 className="m-0 mb-2 font-serif text-xl text-fg">Tool audit</h2>
              <div className="flex flex-col">
                {toolCalls.map((toolCall) => {
                  const renderer = getToolRenderer(toolCall.toolId);
                  return (
                    <div key={toolCall.id} className="flex flex-col border-b border-border py-3 last:border-b-0">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 font-sans text-sm font-medium text-fg">{renderer.title}</span>
                        <RiskBadge riskClass={toolCall.riskClass} />
                      </div>
                      <span className="mt-1 font-sans text-xs text-fg-muted">{displayEnum(toolCall.status)}</span>
                      <TechnicalDetails label={toolCall.result ? "Raw result" : "Technical details"}>
                        <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-button bg-surface-sunken p-3 font-mono text-[11px] text-fg-muted">
                          {JSON.stringify(
                            { toolId: toolCall.toolId, arguments: toolCall.arguments, result: toolCall.result },
                            null,
                            2,
                          )}
                        </pre>
                      </TechnicalDetails>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}
