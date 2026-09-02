"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ASK_LAYOUT, personasForAskPicker, primaryPersonaId, shouldSeedAskDraft } from "@/lib/ask-dialog";
import { ApiClient, ApiError, type Persona } from "@/lib/api-client";
import { handleUnauthorized } from "@/lib/auth";
import { PersonaAvatar } from "./persona-avatar";
import { useToast } from "./toast";
import { NotificationIntentControl } from "./notification-intent-control";
import { Sheet } from "./ui/sheet";

/**
 * The "Ask someone to…" composer, opened from the Ask pill (mobile) or the
 * sidebar's Ask button (desktop). Used to carry its own overlay, Esc
 * handler, and scroll lock -- now a `Sheet`, which supplies all
 * of that plus the swipe/focus-trap/safe-area behavior this never had.
 */
export function DispatchDialog({
  open,
  onClose,
  client,
  personas,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  personas: Persona[];
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notifyOnOutcome, setNotifyOnOutcome] = useState(false);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previouslyOpen = useRef(false);
  const picker = personasForAskPicker(personas);

  // Seed only on closed→open. Roster identity changes must not wipe the draft.
  // Do not depend on `personaId` here: applying the default used to re-run this
  // effect and cancel the open-focus timeout before the textarea existed.
  useEffect(() => {
    const seed = shouldSeedAskDraft(open, previouslyOpen.current);
    previouslyOpen.current = open;
    if (!open || !seed) return;
    setPersonaId(primaryPersonaId(personas));
    setPrompt("");
    setNotifyOnOutcome(false);
    setError(null);
    client.getPushConfig().then(
      (config) => setDeviceCount(config.deviceCount),
      () => setDeviceCount(0),
    );
  }, [client, open, personas]);

  useEffect(() => {
    if (!open || personaId) return;
    const next = primaryPersonaId(personas);
    if (next) setPersonaId(next);
  }, [open, personaId, personas]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  const selected = personas.find((p) => p.id === personaId);

  async function submit() {
    if (!personaId || !prompt.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await client.createJob({ personaId, prompt: prompt.trim(), notifyOnOutcome });
      onClose();
      showToast(`${selected?.name ?? "Someone"} has it.`, { href: `/logs/${job.id}` });
      router.push(`/logs/${job.id}`);
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setError(err instanceof ApiError ? (err.detail ?? `Couldn't send that (${err.status}).`) : "Couldn't send that.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask someone to…"
      anchor="right"
      footer={
        <>
          <span className="flex items-center gap-1.5 font-sans text-[13px] text-fg-muted">
            <i
              className="inline-block h-3.5 w-3.5 rounded-[3px] border"
              style={{ borderColor: "var(--danger)", background: "var(--danger-soft)" }}
            />
            Destructive actions always ask you first
          </span>
          <button
            type="button"
            disabled={!personaId || !prompt.trim() || submitting}
            onClick={submit}
            className="rounded-button border-0 px-4 py-2.5 font-sans text-sm font-medium disabled:opacity-50 sm:ml-auto"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            {submitting ? "Sending…" : "Send it over"}
          </button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Who</p>
        <select
          aria-label="Who"
          value={personaId ?? ""}
          onChange={(e) => setPersonaId(e.target.value || null)}
          className={ASK_LAYOUT.personaSelect}
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
        >
          {picker.length === 0 && <option value="">Nobody on staff yet.</option>}
          {picker.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className={ASK_LAYOUT.personaChips}>
          {personas.length === 0 && <span className="font-sans text-[13px] text-fg-muted">Nobody on staff yet.</span>}
          {picker.map((p) => {
            const active = p.id === personaId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPersonaId(p.id)}
                className="flex items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 font-sans text-[13px]"
                style={{
                  borderColor: active ? "var(--accent-soft-border)" : "var(--border-strong)",
                  background: active ? "var(--accent-soft)" : "var(--surface)",
                  color: active ? "var(--accent-soft-fg)" : "var(--fg-muted)",
                  fontWeight: active ? 500 : 400,
                }}
              >
                <PersonaAvatar id={p.id} name={p.name} role={p.role} size="sm" />
                {p.name}
              </button>
            );
          })}
        </div>
        <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-fg-faint">The task</p>
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Chase Northbank on invoice 4471 and get me revised terms in writing."
          rows={4}
          className="min-h-[6rem] w-full flex-1 resize-none rounded-button border px-4 py-3.5 font-sans text-[15px] outline-none md:min-h-[7.5rem] md:flex-none"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
        />
        <NotificationIntentControl checked={notifyOnOutcome} onChange={setNotifyOnOutcome} deviceCount={deviceCount} />
        {error && (
          <p className="mt-2 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
