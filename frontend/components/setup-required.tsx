"use client";

import { AuthFrame } from "@/components/auth-frame";

/**
 * Full-page block shown in place of the app once signed in, whenever the
 * backend has no LLM provider API key configured (GET /config, ready:false).
 * Before this existed, a key-less deployment let you sign in, hire
 * personas, and create jobs — every job just failed silently in the
 * background with nothing in the UI ever explaining why.
 */
export function SetupRequired({
  onRetry,
  checking,
  onSignOut,
}: {
  onRetry: () => void;
  checking: boolean;
  onSignOut: () => void;
}) {
  return (
    <AuthFrame
      title="No one’s able to work yet"
      description="RetinueOS needs at least one model provider key before your staff can accept work."
    >
      <div className="border-l-2 border-accent-soft-border pl-4">
        <p className="m-0 mb-2 font-mono text-[11px] uppercase tracking-wider text-fg-faint">To fix this</p>
        <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-4 font-sans text-[13px] leading-relaxed text-fg-muted">
          <li>
            In the backend&rsquo;s <code className="font-mono text-fg">.env</code>, set{" "}
            <code className="font-mono text-fg">ANTHROPIC_API_KEY</code> and/or{" "}
            <code className="font-mono text-fg">OPENAI_API_KEY</code>.
          </li>
          <li>Restart the backend so it picks up the new value.</li>
          <li>Come back here and check again.</li>
        </ol>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={checking}
          className="min-h-11 rounded-button border-0 px-4 font-sans text-sm font-medium disabled:opacity-60"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="min-h-11 rounded-button border px-4 font-sans text-sm"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
        >
          Sign out
        </button>
      </div>
    </AuthFrame>
  );
}
