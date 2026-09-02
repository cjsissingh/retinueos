"use client";

import { Fragment, useState } from "react";
import { ApiClient, ApiError, type Persona, type ToolCall } from "@/lib/api-client";
import { RiskFrame, RiskBadge } from "./risk-frame";
import { getToolRenderer } from "@/lib/tool-renderers";
import { useOnlineStatus } from "@/lib/use-online-status";
import { PersonaAvatar } from "./persona-avatar";

/** After the DB row flips to approved/rejected, `resumeJob` still has to
 *  actually run the tool — poll until it lands on a real outcome instead of
 *  assuming success the moment the click fires (05-job-creation-and-audit-
 *  ui.md's I4 finding: "you approved it and now it's gone from the screen
 *  forever"). A rejected call never runs anything further, so it resolves
 *  on the first poll. */
async function pollForOutcome(client: ApiClient, id: string, attempts = 20): Promise<ToolCall> {
  for (let i = 0; i < attempts; i++) {
    const tc = await client.getToolCall(id);
    if (tc.status !== "approved") return tc; // rejected | executed | failed
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return client.getToolCall(id);
}

/**
 * pollForOutcome gives up after ~6s (20 attempts * 300ms) and returns
 * whatever status the call still has at that point -- which, for a turn
 * that's just slow (a real LLM call, a delegation, a slow tool API), can
 * still be "approved": resumeJob hasn't finished yet, not failed. Treating
 * "not executed" as "failed" (the previous behavior: `succeeded =
 * status === "executed"`, with no other branch) told the user their
 * destructive action failed when it was often still quietly in flight --
 * this distinguishes "actually failed" from "still working, ran out of
 * patience polling" so the UI doesn't lie about which one happened.
 */
export function describeOutcome(status: ToolCall["status"]) {
  if (status === "executed") return { label: "Done.", tone: "success" as const };
  if (status === "cancelled") return { label: "Cancelled.", tone: "danger" as const };
  if (status === "failed" || status === "rejected") return { label: "It failed.", tone: "danger" as const };
  return { label: "Still working — check the Audit page for the outcome.", tone: "pending" as const };
}

export function ApprovalItem({
  client,
  toolCall: initialToolCall,
  persona,
  onResolved,
  online: onlineProp,
}: {
  client: ApiClient;
  toolCall: ToolCall;
  persona?: Persona;
  onResolved: (id: string) => void;
  /** overrides the live useOnlineStatus() read for tests. Real
   *  callers (Today, Approvals) never pass this -- they get the actual
   *  connectivity state. */
  online?: boolean;
}) {
  const [toolCall, setToolCall] = useState(initialToolCall);
  const [busy, setBusy] = useState(false);
  // approvals are never optimistic offline -- acting on a call
  // that's gone stale (already resolved elsewhere, a tool that's since
  // changed) is a real side effect once the request lands, so Approve /
  // Deny / Always allow stay disabled rather than queuing like the chat
  // composer does.
  const liveOnline = useOnlineStatus();
  const online = onlineProp ?? liveOnline;
  const [confirming, setConfirming] = useState<"approve" | "deny" | "always" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"running" | "done" | null>(null);

  const renderer = getToolRenderer(toolCall.toolId);
  const fields = renderer.fields(toolCall.arguments);
  const isDestructive = toolCall.riskClass === "destructive";

  async function resolve(approve: boolean, alwaysAllow = false) {
    setBusy(true);
    setError(null);
    try {
      const resolved = !approve
        ? await client.rejectToolCall(toolCall.id)
        : alwaysAllow
          ? await client.alwaysAllowToolCall(toolCall.id)
          : await client.approveToolCall(toolCall.id);
      setToolCall(resolved);
      if (!approve) {
        // A rejection never executes anything — safe to remove immediately.
        onResolved(toolCall.id);
        return;
      }
      setOutcome("running");
      const final = await pollForOutcome(client, toolCall.id);
      setToolCall(final);
      setOutcome("done");
    } catch (err) {
      setError(
        err instanceof ApiError ? `That didn't go through (${err.status}). Try again.` : "That didn't go through.",
      );
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  if (outcome) {
    const done = describeOutcome(toolCall.status);
    const toneColor = {
      success: "var(--success-soft-fg)",
      danger: "var(--danger-soft-fg)",
      pending: "var(--fg-muted)",
    } satisfies Record<typeof done.tone, string>;
    return (
      <RiskFrame riskClass={toolCall.riskClass} className="shadow-rest">
        <div className="p-6">
          <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
            {persona && <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />}
            <span className="font-sans text-[13px] font-medium text-fg-muted">{renderer.title}</span>
            <RiskBadge riskClass={toolCall.riskClass} />
          </div>
          {outcome === "running" && <p className="m-0 font-sans text-sm text-fg-muted">Approved — running…</p>}
          {outcome === "done" && (
            <>
              <p className="m-0 mb-2 font-sans text-[15px] font-semibold" style={{ color: toneColor[done.tone] }}>
                {done.label}
              </p>
              {toolCall.result && (
                <pre
                  className="m-0 overflow-x-auto whitespace-pre-wrap rounded-button border p-3 font-mono text-xs text-fg-muted"
                  style={{ borderColor: "var(--border)", background: "var(--surface-sunken)" }}
                >
                  {JSON.stringify(toolCall.result, null, 2)}
                </pre>
              )}
              <button
                type="button"
                onClick={() => onResolved(toolCall.id)}
                className="mt-3 rounded-button border px-3.5 py-2 font-sans text-[13px]"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      </RiskFrame>
    );
  }

  return (
    <RiskFrame riskClass={toolCall.riskClass} className="shadow-rest">
      <div className="p-6">
        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          {persona && <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />}
          <span className="font-sans text-[13px] font-medium text-fg-muted">{persona?.name ?? "Someone"} wants to</span>
          <RiskBadge riskClass={toolCall.riskClass} />
        </div>

        <h3
          className="m-0 mb-3.5 font-sans text-[19px] font-semibold"
          style={{ color: isDestructive ? "var(--danger-soft-fg)" : "var(--fg)" }}
        >
          {renderer.title}
        </h3>

        <div
          className="mb-4 grid gap-x-3.5 gap-y-2 rounded-button border p-4"
          style={{ borderColor: "var(--border)", background: "var(--surface-sunken)", gridTemplateColumns: "76px 1fr" }}
        >
          {fields.map((f) => (
            <Fragment key={f.label}>
              <span className="font-mono text-[11px] uppercase tracking-wider text-fg-faint">{f.label}</span>
              <span className="whitespace-pre-wrap font-sans text-sm text-fg">{f.value}</span>
            </Fragment>
          ))}
        </div>

        {error && (
          <p className="mb-3 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        {!confirming && (
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={busy || !online}
              onClick={() => setConfirming("approve")}
              className="rounded-button border-0 px-4 py-2.5 font-sans text-sm font-medium disabled:opacity-50"
              style={
                isDestructive
                  ? { background: "var(--danger)", color: "var(--danger-fg)" }
                  : { background: "var(--fg)", color: "var(--bg)" }
              }
            >
              {isDestructive ? "Send it" : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy || !online}
              onClick={() => setConfirming("deny")}
              className="rounded-button border px-4 py-2.5 font-sans text-sm disabled:opacity-50"
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
            >
              Deny
            </button>
            {!isDestructive && (
              <button
                type="button"
                disabled={busy || !online}
                onClick={() => setConfirming("always")}
                className="rounded-button border px-4 py-2.5 font-sans text-sm disabled:opacity-50"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Always allow
              </button>
            )}
            <span className="ml-2 font-sans text-xs text-fg-faint">
              {!online
                ? "You're offline — approving or denying is disabled. This isn't optimistic; acting on a stale approval is a real change."
                : isDestructive
                  ? "Both open a confirm step."
                  : "Always allow skips this prompt on later runs."}
            </span>
          </div>
        )}

        {confirming === "approve" && (
          <div
            className="rounded-button border p-4.5"
            style={{
              borderColor: isDestructive ? "var(--danger-soft-border)" : "var(--border-strong)",
              background: isDestructive ? "var(--danger-soft)" : "var(--surface-sunken)",
            }}
          >
            <p
              className="m-0 mb-1 font-sans text-[15px] font-semibold"
              style={{ color: isDestructive ? "var(--danger-soft-fg)" : "var(--fg)" }}
            >
              {isDestructive ? "This can't be undone once sent." : "Go ahead with this?"}
            </p>
            <div className="mt-3 flex gap-2.5">
              <button
                type="button"
                disabled={busy || !online}
                onClick={() => resolve(true)}
                className="rounded-button border-0 px-4.5 py-2.5 font-sans text-sm font-medium disabled:opacity-50"
                style={
                  isDestructive
                    ? { background: "var(--danger)", color: "var(--danger-fg)" }
                    : { background: "var(--fg)", color: "var(--bg)" }
                }
              >
                {busy ? "Working…" : isDestructive ? "Yes, send it" : "Yes, approve"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="rounded-button border px-4 py-2.5 font-sans text-sm"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {confirming === "always" && (
          <div
            className="rounded-button border p-4.5"
            style={{ borderColor: "var(--border-strong)", background: "var(--surface-sunken)" }}
          >
            <p className="m-0 mb-1 font-sans text-[15px] font-semibold text-fg">
              Always allow this tool for {persona?.name ?? "this persona"}?
            </p>
            <p className="m-0 font-sans text-[13px] text-fg-muted">
              Later chat turns and routine runs will not ask again. You can change this in their tool permissions.
            </p>
            <div className="mt-3 flex gap-2.5">
              <button
                type="button"
                disabled={busy || !online}
                onClick={() => resolve(true, true)}
                className="rounded-button border-0 px-4.5 py-2.5 font-sans text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--fg)", color: "var(--bg)" }}
              >
                {busy ? "Working…" : "Yes, always allow"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="rounded-button border px-4 py-2.5 font-sans text-sm"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {confirming === "deny" && (
          <div
            className="rounded-button border p-4.5"
            style={{ borderColor: "var(--border-strong)", background: "var(--surface-sunken)" }}
          >
            <p className="m-0 mb-1 font-sans text-[15px] font-semibold text-fg">Deny this request?</p>
            <div className="mt-3 flex gap-2.5">
              <button
                type="button"
                disabled={busy || !online}
                onClick={() => resolve(false)}
                className="rounded-button border px-4.5 py-2.5 font-sans text-sm font-medium disabled:opacity-50"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
              >
                {busy ? "Working…" : "Yes, deny"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="rounded-button border px-4 py-2.5 font-sans text-sm"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </RiskFrame>
  );
}
