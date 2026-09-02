"use client";

import { useEffect, useState } from "react";
import { ApiClient, ApiError, type Persona } from "@/lib/api-client";
import { useModelCatalog } from "@/lib/use-model-catalog";
import { displayModelName } from "@/lib/display";

const ALL_PROVIDERS = ["anthropic", "openai"];

const inputClass =
  "w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

/**
 * Identity section of the persona workspace — name, role, voice,
 * and which model this persona runs on. The mark itself isn't editable here:
 * it's hashed from the persona's id (persona-avatar.tsx), not a stored
 * field, so there's nothing to pick. Model provider/model live here rather
 * than a section of their own — design guide's Identity/Charter/Tools/
 * Team/Routines/Memory/Usage list has no separate slot for them, and they're
 * as much "who this persona is" as name and role are. Don't duplicate this
 * picker into another section.
 */
export function PersonaIdentityForm({
  client,
  persona,
  onSaved,
}: {
  client: ApiClient;
  persona: Persona;
  onSaved: (persona: Persona) => void;
}) {
  const [name, setName] = useState(persona.name);
  const [role, setRole] = useState(persona.role);
  const [voiceNotes, setVoiceNotes] = useState(persona.voiceNotes);
  const [modelProvider, setModelProvider] = useState(persona.modelProvider);
  const [modelName, setModelName] = useState(persona.modelName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = useModelCatalog(client);
  const modelOptions = models?.[modelProvider] ?? [];

  // null = "haven't heard back yet" -- see PersonaForm's own copy of this
  // distinction. Only used here to annotate providers with no key
  // configured, not to steer the selection -- an existing persona's
  // provider is its real saved value, editing name/role shouldn't change it.
  const [availableProviders, setAvailableProviders] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    client.getConfig().then(
      ({ availableProviders: providers }) => {
        if (!cancelled) setAvailableProviders(providers);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await client.updatePersona(persona.id, { name, role, voiceNotes, modelProvider, modelName });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? `Couldn't save changes (${err.status}).` : "Couldn't save changes.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className={inputClass}
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Role</span>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            required
            className={inputClass}
            style={inputStyle}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[13px] font-medium text-fg">Voice &amp; personality</span>
        <span className="font-sans text-xs text-fg-faint">
          How they sound and act when talking to you — never leaks into anything drafted for someone else.
        </span>
        <textarea
          value={voiceNotes}
          onChange={(e) => setVoiceNotes(e.target.value)}
          rows={3}
          className={inputClass}
          style={inputStyle}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Provider</span>
          <select
            value={modelProvider}
            onChange={(e) => setModelProvider(e.target.value)}
            className={inputClass}
            style={inputStyle}
          >
            {ALL_PROVIDERS.map((provider) => {
              const configured = availableProviders === null || availableProviders.includes(provider);
              return (
                <option key={provider} value={provider}>
                  {provider === "openai" ? "OpenAI" : "Anthropic"}
                  {configured ? "" : " (no API key configured)"}
                </option>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Model</span>
          {modelOptions.length > 0 ? (
            <select
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className={inputClass}
              style={inputStyle}
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {displayModelName(modelProvider, m)}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={models === null ? "Loading models…" : "Model name"}
              className={inputClass}
              style={inputStyle}
            />
          )}
        </label>
      </div>
      {availableProviders !== null && !availableProviders.includes(modelProvider) && (
        <p className="m-0 font-sans text-xs" style={{ color: "var(--danger)" }}>
          No API key is configured for {modelProvider} — every job for this persona will fail until one is set.
        </p>
      )}
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
