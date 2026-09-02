"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiClient, type Job, type Persona, type ToolCall, type ToolCallStatus } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { RiskBadge } from "@/components/risk-frame";
import { PersonaAvatar } from "@/components/persona-avatar";
import { RowSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { getToolRenderer } from "@/lib/tool-renderers";
import { FILTER_CHIP, FILTER_ROW, LIST_ROW, PAGE_PAD, TWO_LINE_META, TWO_LINE_ROW } from "@/lib/touch-layout";
import { relativeTime } from "@/lib/display";

type LoadState = "loading" | "ready" | "error";

const STATUS_META = {
  pending_approval: { label: "Waiting for approval", fg: "var(--warning-soft-fg)", bg: "var(--warning-soft)" },
  approved: { label: "Approved", fg: "var(--running-soft-fg)", bg: "var(--running-soft)" },
  rejected: { label: "Rejected", fg: "var(--fg-muted)", bg: "var(--neutral-soft)" },
  cancelled: { label: "Cancelled", fg: "var(--fg-muted)", bg: "var(--neutral-soft)" },
  executed: { label: "Executed", fg: "var(--success-soft-fg)", bg: "var(--success-soft)" },
  failed: { label: "Failed", fg: "var(--danger-soft-fg)", bg: "var(--danger-soft)" },
} satisfies Record<ToolCallStatus, { label: string; fg: string; bg: string }>;

const STATUS_FILTERS: Array<{ id: ToolCallStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "pending_approval", label: "Waiting" },
  { id: "executed", label: "Executed" },
  { id: "failed", label: "Failed" },
  { id: "rejected", label: "Rejected" },
  { id: "cancelled", label: "Cancelled" },
];

/**
 * Every tool_calls row, not just pending ones, filterable by persona or
 * status — so an approved action is still visible after it leaves the
 * Approvals queue.
 */
export function AuditContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const personaId = searchParams.get("personaId") ?? "";
  // SAFETY: an unrecognized `?status=` value just fails every `=== status`
  // comparison below (statusFilter filtering, STATUS_FILTERS button
  // active-state) -- there's no unsafe read through this cast, only an
  // empty-looking filter until the URL is corrected.
  const statusFilter = (searchParams.get("status") as ToolCallStatus | null) ?? "all";

  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [callList, personaList, jobList] = await Promise.all([
        client.listAllToolCalls(),
        client.listPersonas(),
        client.listJobs(),
      ]);
      setCalls(callList);
      setPersonas(personaList);
      setJobs(jobList);
      setState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setState("error");
    }
  }, [client, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/audit?${next.toString()}`);
  }

  const personaById = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  const filtered = useMemo(() => {
    let list = statusFilter === "all" ? calls : calls.filter((c) => c.status === statusFilter);
    if (personaId) list = list.filter((c) => jobById.get(c.jobId)?.personaId === personaId);
    return list;
  }, [calls, statusFilter, personaId, jobById]);

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={`${calls.length} tool calls`}
        title="Audit"
        description="A human-readable history of consequential tool activity. Technical identifiers remain available as supporting detail."
      />

      <div className={`mb-4 ${FILTER_ROW}`}>
        {STATUS_FILTERS.map((f) => {
          const active = statusFilter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setParam("status", f.id === "all" ? null : f.id)}
              className={FILTER_CHIP}
              style={{
                borderColor: active ? "transparent" : "var(--border-strong)",
                background: active ? "var(--fg)" : "var(--surface)",
                color: active ? "var(--bg)" : "var(--fg-muted)",
                fontWeight: active ? 500 : 400,
              }}
            >
              {f.label}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px flex-none" style={{ background: "var(--border)" }} />
        <select
          value={personaId}
          onChange={(e) => setParam("personaId", e.target.value || null)}
          className="min-h-11 flex-none rounded-button border px-3 font-sans text-[13px]"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
        >
          <option value="">Everyone</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {state === "error" && <ErrorState detail="GET /tool_calls failed. Nothing has been lost." onRetry={load} />}

      {state === "loading" && (
        <div className="flex flex-col gap-3">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      )}

      {state === "ready" && filtered.length === 0 && (
        <EmptyState
          title={calls.length === 0 ? "No tool activity yet" : "No matching activity"}
          description={
            calls.length === 0 ? "Tool actions will appear here as the house gets to work." : "Try another filter."
          }
        />
      )}

      {state === "ready" && filtered.length > 0 && (
        <div className="flex flex-col border-y border-border">
          {filtered.map((tc) => {
            const renderer = getToolRenderer(tc.toolId);
            const meta = STATUS_META[tc.status];
            const persona = personaById.get(jobById.get(tc.jobId)?.personaId ?? "");
            return (
              <Link
                key={tc.id}
                href={`/logs/${tc.jobId}`}
                className={`${LIST_ROW} block border-b border-border px-1 no-underline last:border-b-0 md:px-2`}
                style={{ color: "inherit" }}
              >
                {/* Below md: primary line (what happened) + meta line
                    (status · who · when) instead of every column (badge,
                    title/toolId, persona, risk badge, job id) stacking on
                    its own line. */}
                <div className={TWO_LINE_ROW}>
                  <span className="truncate font-sans text-sm font-medium text-fg">{renderer.title}</span>
                  <span className={TWO_LINE_META}>
                    <span style={{ color: meta.fg }}>{meta.label}</span>
                    <span aria-hidden="true">·</span>
                    {persona && <span className="max-w-[100px] truncate">{persona.name}</span>}
                    {persona && <span aria-hidden="true">·</span>}
                    <span className="flex-none">{relativeTime(tc.createdAt)}</span>
                  </span>
                </div>
                <div className="hidden py-3 md:flex md:items-center md:gap-3.5">
                  <span
                    className="rounded-badge px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-wider"
                    style={{ color: meta.fg, background: meta.bg }}
                  >
                    {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 font-sans text-sm font-medium text-fg">{renderer.title}</p>
                    <code className="font-mono text-[11px] text-fg-faint">{tc.toolId}</code>
                  </div>
                  {persona && (
                    <span className="flex items-center gap-1.5 font-sans text-[13px] text-fg-muted">
                      <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
                      {persona.name}
                    </span>
                  )}
                  <RiskBadge riskClass={tc.riskClass} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
