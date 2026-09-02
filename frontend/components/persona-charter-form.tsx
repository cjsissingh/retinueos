"use client";

import { useState } from "react";
import { ApiClient, ApiError, type Persona } from "@/lib/api-client";

const inputClass =
  "w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

/**
 * Charter section of the persona workspace — core instructions,
 * scope, and boundaries. Boundaries is danger-framed per design guide:
 * it's the one field here that's a hard limit rather than guidance.
 */
export function PersonaCharterForm({
  client,
  persona,
  onSaved,
}: {
  client: ApiClient;
  persona: Persona;
  onSaved: (persona: Persona) => void;
}) {
  const [systemPrompt, setSystemPrompt] = useState(persona.systemPrompt);
  const [scopeDescription, setScopeDescription] = useState(persona.scopeDescription);
  const [boundaries, setBoundaries] = useState(persona.boundaries);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await client.updatePersona(persona.id, { systemPrompt, scopeDescription, boundaries });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? `Couldn't save changes (${err.status}).` : "Couldn't save changes.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[13px] font-medium text-fg">Core instructions</span>
        <span className="font-sans text-xs text-fg-faint">
          What this person is responsible for and how they should work.
        </span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          required
          rows={6}
          className={inputClass}
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[13px] font-medium text-fg">Scope</span>
        <span className="font-sans text-xs text-fg-faint">What&rsquo;s in bounds for this persona.</span>
        <textarea
          value={scopeDescription}
          onChange={(e) => setScopeDescription(e.target.value)}
          rows={3}
          className={inputClass}
          style={inputStyle}
        />
      </label>
      <label
        className="flex flex-col gap-1.5 rounded-card border p-4"
        style={{ borderColor: "var(--danger-soft-border)", background: "var(--danger-soft)" }}
      >
        <span className="font-sans text-[13px] font-medium" style={{ color: "var(--danger-soft-fg)" }}>
          Boundaries — hard limits
        </span>
        <span className="font-sans text-xs" style={{ color: "var(--danger-soft-fg)" }}>
          Not suggestions — e.g. &ldquo;never gives investment advice&rdquo;.
        </span>
        <textarea
          value={boundaries}
          onChange={(e) => setBoundaries(e.target.value)}
          rows={3}
          className={inputClass}
          style={{ ...inputStyle, background: "var(--surface)" }}
        />
      </label>
      {error && (
        <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="min-h-11 self-start rounded-button border-0 px-4 py-2 font-sans text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
      >
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
