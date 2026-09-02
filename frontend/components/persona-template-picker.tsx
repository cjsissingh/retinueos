"use client";

import { useState } from "react";
import { ApiClient, ApiError, type PersonaGeneratedDraft, type PersonaTemplate } from "@/lib/api-client";

const inputClass =
  "w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

/**
 * The compact "starting point" step ahead of the hire form. A transient
 * choice, not a page of its own: picking a template, describing what's needed, or
 * starting from scratch all hand off to `PersonaForm`, which stays the one
 * place a persona is actually filled in and submitted.
 */
export function PersonaTemplatePicker({
  client,
  templates,
  onChoose,
  loading = false,
}: {
  client: ApiClient;
  templates: PersonaTemplate[];
  onChoose: (draft: PersonaGeneratedDraft | null) => void;
  loading?: boolean;
}) {
  const [describing, setDescribing] = useState(false);
  const [description, setDescription] = useState("");
  const [seedTemplateSlug, setSeedTemplateSlug] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setError(null);
    try {
      const draft = await client.generatePersonaDraft({
        description,
        seedTemplateSlug: seedTemplateSlug || undefined,
      });
      onChoose(draft);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 422
          ? "AI persona generation isn't configured yet — describe it to yourself in the form instead, or ask an admin to add an Anthropic API key."
          : "Couldn't generate a draft. Try describing it differently, or start from scratch.",
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-card border p-5"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div>
        <h3 className="m-0 font-serif text-lg text-fg">Hire a persona</h3>
        <p className="m-0 mt-1 font-sans text-[13px] text-fg-muted">
          Start from a template, describe what you need, or build one from scratch.
        </p>
      </div>

      {describing ? (
        <form onSubmit={handleGenerate} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-sans text-[13px] font-medium text-fg">What do you need help with?</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Someone to track my reading list and suggest what to read next"
              required
              rows={3}
              className={inputClass}
              style={inputStyle}
            />
          </label>
          {templates.length > 0 && (
            <label className="flex flex-col gap-1.5">
              <span className="font-sans text-[13px] font-medium text-fg">
                Base it on a template? <span className="text-fg-faint">(optional)</span>
              </span>
              <select
                value={seedTemplateSlug}
                onChange={(e) => setSeedTemplateSlug(e.target.value)}
                className={inputClass}
                style={inputStyle}
              >
                <option value="">No — start fresh</option>
                {templates.map((template) => (
                  <option key={template.slug} value={template.slug}>
                    {template.name} &middot; {template.role}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={generating}
              className="min-h-11 rounded-button border-0 px-4 py-2 font-sans text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              {generating ? "Drafting…" : "Draft with AI"}
            </button>
            <button
              type="button"
              onClick={() => setDescribing(false)}
              className="min-h-11 rounded-button border px-4 py-2 font-sans text-sm"
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
            >
              Back
            </button>
          </div>
        </form>
      ) : loading ? (
        <p className="m-0 font-sans text-[13px] text-fg-faint">Loading starter templates…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <button
              key={template.slug}
              type="button"
              onClick={() => onChoose(template)}
              className="flex min-h-11 flex-col items-start gap-1.5 rounded-button border p-3.5 text-left"
              style={{ borderColor: "var(--border)", background: "var(--bg)" }}
            >
              <span className="font-sans text-sm font-semibold text-fg">{template.name}</span>
              <span className="font-sans text-[13px] text-fg-muted">{template.role}</span>
              <span className="font-sans text-[13px] leading-relaxed text-fg-faint [text-wrap:pretty]">
                {template.scopeDescription}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDescribing(true)}
            className="flex min-h-11 flex-col items-start justify-center gap-1 rounded-button border p-3.5 text-left"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
          >
            <span className="font-sans text-sm font-semibold text-fg">Describe what you need</span>
            <span className="font-sans text-[13px] text-fg-muted">AI drafts a persona from your description.</span>
          </button>
          <button
            type="button"
            onClick={() => onChoose(null)}
            className="flex min-h-11 flex-col items-start justify-center gap-1 rounded-button border border-dashed p-3.5 text-left"
            style={{ borderColor: "var(--border-strong)", background: "transparent" }}
          >
            <span className="font-sans text-sm font-semibold text-fg">Start from scratch</span>
            <span className="font-sans text-[13px] text-fg-muted">A blank persona you fill in yourself.</span>
          </button>
        </div>
      )}
    </div>
  );
}
