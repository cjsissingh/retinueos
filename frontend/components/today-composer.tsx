"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { personasForAskPicker, primaryPersonaId } from "@/lib/ask-dialog";
import { delegatedChatHref } from "@/lib/chat-navigation";
import { ApiClient, ApiError, type Persona } from "@/lib/api-client";
import { handleUnauthorized } from "@/lib/auth";
import { PersonaAvatar } from "./persona-avatar";
import { TOUCH_TARGET } from "@/lib/touch-layout";

/**
 * The Today screen's inline "Ask someone to…" composer (design guide
 * §01) — a single row inline on the page, not the ⌘K `DispatchDialog`
 * overlay, which keeps landing on `/logs/:id`. This one sends and navigates
 * straight into the new chat, since that's the point of being on Today
 * already: `/roster/:personaId?chat=:jobId`.
 */
export function TodayComposer({ client, personas }: { client: ApiClient; personas: Persona[] }) {
  const router = useRouter();
  const picker = personasForAskPicker(personas);
  const [personaId, setPersonaId] = useState<string | null>(() => primaryPersonaId(personas));
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const selectedId = personaId ?? primaryPersonaId(personas);
    if (!selectedId || !prompt.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await client.createJob({ personaId: selectedId, prompt: prompt.trim(), notifyOnOutcome: false });
      setPrompt("");
      router.push(delegatedChatHref(job));
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setError(err instanceof ApiError ? (err.detail ?? `Couldn't send that (${err.status}).`) : "Couldn't send that.");
    } finally {
      setSubmitting(false);
    }
  }

  if (personas.length === 0) return null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <input
          type="text"
          name="request"
          autoComplete="off"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask someone to…"
          aria-label="Ask someone to…"
          className={`min-w-0 flex-1 rounded-button border px-4 font-sans text-[15px] outline-none ${TOUCH_TARGET}`}
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
        />
        <button
          type="submit"
          disabled={submitting || !prompt.trim() || !personaId}
          className={`flex-none rounded-button border-0 px-4 font-sans text-sm font-medium disabled:opacity-50 ${TOUCH_TARGET}`}
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {submitting ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {picker.map((p) => {
          const active = p.id === personaId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPersonaId(p.id)}
              className="flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 font-sans text-[13px]"
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
      {error && (
        <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </form>
  );
}
