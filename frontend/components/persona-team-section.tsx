"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiClient, ApiError, type Persona } from "@/lib/api-client";
import { PersonaAvatar } from "@/components/persona-avatar";

const inputClass =
  "w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

/**
 * Team section of the persona workspace — the single "Reports to"
 * select, plus the read-only direct-reports list. This is the *only* place
 * a reports-to select renders; the old duplicate that used to live in the
 * generic Profile form is gone along with Profile itself.
 */
export function PersonaTeamSection({
  client,
  persona,
  managerCandidates,
  directReports,
  onSaved,
}: {
  client: ApiClient;
  persona: Persona;
  /** Candidates for "reports to" -- caller excludes the persona itself and
   *  its descendants so a reporting cycle can't even be selected. */
  managerCandidates: Persona[];
  directReports: Persona[];
  onSaved: (persona: Persona) => void;
}) {
  const [reportsTo, setReportsTo] = useState(persona.reportsTo ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await client.updatePersona(persona.id, { reportsTo: reportsTo || null });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? `Couldn't save changes (${err.status}).` : "Couldn't save changes.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Reports to — the org chart</span>
          <select
            value={reportsTo}
            onChange={(e) => setReportsTo(e.target.value)}
            className={inputClass}
            style={inputStyle}
          >
            <option value="">Nobody — top of the chart</option>
            {managerCandidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} &middot; {p.role}
              </option>
            ))}
          </select>
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

      <div className="overflow-hidden rounded-card border" style={{ borderColor: "var(--border)" }}>
        <div
          className="border-b px-4.5 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint"
          style={{ background: "var(--surface-sunken)", borderColor: "var(--border)" }}
        >
          Direct reports
        </div>
        {directReports.length === 0 && (
          <p className="p-4.5 font-sans text-sm text-fg-muted">Nobody reports to {persona.name} yet.</p>
        )}
        {directReports.map((report) => (
          <Link
            key={report.id}
            href={`/roster/${report.id}`}
            className="flex items-center gap-3.5 border-b px-4.5 py-3 no-underline last:border-b-0"
            style={{ borderColor: "var(--border)", color: "inherit" }}
          >
            <PersonaAvatar id={report.id} name={report.name} role={report.role} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-sans text-sm text-fg">{report.name}</span>
              <span className="block truncate font-sans text-[12px] text-fg-muted">{report.role}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
