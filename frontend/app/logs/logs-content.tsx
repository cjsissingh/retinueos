"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiClient, type Digest, type Job, type JobStatus, type Persona } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { DigestHistoryList } from "@/components/digest-history-list";
import { JobStatusBadge } from "@/components/status-badge";
import { PersonaAvatar } from "@/components/persona-avatar";
import { RowSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  FILTER_CHIP,
  FILTER_ROW,
  LIST_ROW,
  PAGE_PAD,
  SECONDARY_BUTTON,
  TWO_LINE_META,
  TWO_LINE_ROW,
} from "@/lib/touch-layout";

const TERMINAL = new Set(["done", "failed", "waiting_approval", "cancelled", "timed_out", "outcome_unknown"]);
const PAGE_SIZE = 25;
const STATUS_FILTERS: Array<{ id: JobStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "cancelling", label: "Cancelling" },
  { id: "waiting_approval", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "timed_out", label: "Timed out" },
  { id: "outcome_unknown", label: "Check outcome" },
];

const ORIGIN_LABEL = {
  user: "Asked directly",
  cron: "Scheduled run",
  delegation: "Delegated task",
} satisfies Record<Job["origin"], string>;

type LoadState = "loading" | "ready" | "error";

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function LogsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const personaId = searchParams.get("personaId") ?? "";
  const view = searchParams.get("view") === "digests" ? "digests" : "jobs";
  // SAFETY: same as audit-content.tsx's statusFilter -- an unrecognized
  // `?status=` value just fails every `=== status` comparison below, no
  // unsafe read through this cast.
  const statusFilter = (searchParams.get("status") as JobStatus | null) ?? "all";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const [digests, setDigests] = useState<Digest[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [jobList, personaList, digestList] = await Promise.all([
        client.listJobs(personaId || undefined),
        client.listPersonas(),
        client.listDigests(personaId || undefined),
      ]);
      setJobs(jobList);
      setPersonas(personaList);
      setDigests(digestList);
      setState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setState("error");
    }
  }, [client, personaId, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  useEffect(() => {
    const unsubscribers = jobs
      .filter((j) => !TERMINAL.has(j.status))
      .map((j) =>
        client.streamJob(j.id, () => {
          client.getJob(j.id).then((updated) => {
            setJobs((prev) => prev.map((existing) => (existing.id === updated.id ? updated : existing)));
          });
        }),
      );
    return () => unsubscribers.forEach((unsub) => unsub());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.map((j) => j.id).join(",")]);

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    if (key === "view") next.delete("status");
    router.push(`/logs?${next.toString()}`);
  }

  const personaById = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);

  const filtered = useMemo(() => {
    const list = statusFilter === "all" ? jobs : jobs.filter((j) => j.status === statusFilter);
    return [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [jobs, statusFilter]);

  const showingJobs = view === "jobs";
  const listLength = showingJobs ? filtered.length : digests.length;
  const totalPages = Math.max(1, Math.ceil(listLength / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const digestPageItems = digests.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const counts = useMemo(() => {
    const out: Partial<Record<JobStatus, number>> = {};
    for (const j of jobs) out[j.status] = (out[j.status] ?? 0) + 1;
    return out;
  }, [jobs]);

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={showingJobs ? `${jobs.length} jobs · newest first` : `${digests.length} digests · newest first`}
        title="Logs"
      />

      <div className={`mb-4 ${FILTER_ROW}`}>
        <SegmentedControl
          label="Log kind"
          value={view}
          className="flex-none"
          options={[
            { value: "jobs", label: `Jobs ${jobs.length}` },
            { value: "digests", label: `Digests ${digests.length}` },
          ]}
          onChange={(next) => setParam("view", next === "jobs" ? null : next)}
        />
        <span className="mx-1 h-4 w-px flex-none bg-border" />
        {showingJobs &&
          STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.id || (f.id === "all" && statusFilter === "all");
            const count = f.id === "all" ? undefined : counts[f.id];
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
                {f.label}{" "}
                {count ? <span style={{ color: active ? "var(--bg)" : "var(--fg-faint)" }}>{count}</span> : null}
              </button>
            );
          })}
        {showingJobs && <span className="mx-1 h-4 w-px flex-none bg-border" />}
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

      {state === "error" && (
        <ErrorState
          detail={
            showingJobs ? "GET /jobs failed. Nothing has been lost." : "GET /digests failed. Nothing has been lost."
          }
          onRetry={load}
        />
      )}

      {state === "loading" && (
        <div className="flex flex-col gap-3">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      )}

      {state === "ready" && showingJobs && filtered.length === 0 && (
        <EmptyState
          title={jobs.length === 0 ? "No jobs yet" : `No ${statusFilter === "all" ? "" : statusFilter} jobs`}
          description={jobs.length === 0 ? "Ask someone to do something." : "Try a different filter."}
        />
      )}

      {state === "ready" && !showingJobs && digests.length === 0 && (
        <EmptyState
          title="No digests yet"
          description="A digest routine writes one of these when it runs. Nothing has been lost."
        />
      )}

      {state === "ready" && showingJobs && filtered.length > 0 && (
        <div className="overflow-hidden rounded-card border" style={{ borderColor: "var(--border)" }}>
          <div
            className="hidden grid-cols-[130px_1fr_150px_100px_110px] gap-4 border-b px-5 py-2.5 font-mono text-[11px] uppercase tracking-wider text-fg-faint md:grid"
            style={{ background: "var(--surface-sunken)", borderColor: "var(--border)" }}
          >
            <span>Status</span>
            <span>Task</span>
            <span>Who</span>
            <span>Updated ▾</span>
            <span>Job</span>
          </div>
          {pageItems.map((job) => {
            const persona = personaById.get(job.personaId);
            return (
              <Link
                key={job.id}
                href={`/logs/${job.id}`}
                className={`${LIST_ROW} block border-b px-4 no-underline last:border-b-0 md:px-5`}
                style={{ borderColor: "var(--border)", color: "inherit" }}
              >
                {/* Below md: primary line (what happened) + meta line
                    (status · who · when) -- the grid's five columns
                    stacked on their own lines instead would run to four
                    lines, not two, and a `<code>` job-id column doesn't
                    wrap at all. */}
                <div className={TWO_LINE_ROW}>
                  <span className="truncate font-sans text-sm text-fg" title={job.prompt ?? undefined}>
                    {job.prompt || ORIGIN_LABEL[job.origin]}
                  </span>
                  <span className={TWO_LINE_META}>
                    <JobStatusBadge status={job.status} className="flex-none" />
                    <span aria-hidden="true">·</span>
                    <span className="max-w-[120px] truncate">{persona?.name ?? "—"}</span>
                    <span aria-hidden="true">·</span>
                    <span className="flex-none">{relativeTime(job.updatedAt)}</span>
                  </span>
                </div>
                <div className="hidden py-3 md:grid md:grid-cols-[130px_1fr_150px_100px_110px] md:items-center md:gap-4">
                  <JobStatusBadge status={job.status} className="justify-self-start" />
                  <span className="truncate font-sans text-sm text-fg" title={job.prompt ?? undefined}>
                    {job.prompt || ORIGIN_LABEL[job.origin]}
                  </span>
                  <span className="flex items-center gap-2 font-sans text-[13px] text-fg-muted">
                    {persona ? (
                      <>
                        <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
                        {persona.name}
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="font-mono text-xs text-fg-muted">{relativeTime(job.updatedAt)}</span>
                  <code className="font-mono text-xs text-fg-faint">{job.id.slice(0, 8)}</code>
                </div>
              </Link>
            );
          })}
          <div
            className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5"
            style={{ background: "var(--surface-sunken)" }}
          >
            <span className="font-sans text-[13px] text-fg-muted">
              {(clampedPage - 1) * PAGE_SIZE + 1}&ndash;{Math.min(clampedPage * PAGE_SIZE, filtered.length)} of{" "}
              {filtered.length}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={clampedPage <= 1}
                onClick={() => setParam("page", String(clampedPage - 1))}
                className={`${SECONDARY_BUTTON} px-3 disabled:opacity-40`}
                style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={clampedPage >= totalPages}
                onClick={() => setParam("page", String(clampedPage + 1))}
                className={`${SECONDARY_BUTTON} px-3 disabled:opacity-40`}
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {state === "ready" && !showingJobs && digests.length > 0 && (
        <div className="overflow-hidden rounded-card border border-border">
          <DigestHistoryList digests={digestPageItems} personas={personas} />
          <div className="flex items-center justify-between gap-4 bg-surface-sunken px-4 py-3 sm:px-5">
            <span className="font-sans text-[13px] text-fg-muted">
              {(clampedPage - 1) * PAGE_SIZE + 1}&ndash;{Math.min(clampedPage * PAGE_SIZE, listLength)} of {listLength}
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={clampedPage <= 1}
                onClick={() => setParam("page", String(clampedPage - 1))}
                className={`${SECONDARY_BUTTON} border-border bg-surface px-3 text-fg-muted disabled:opacity-40`}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={clampedPage >= totalPages}
                onClick={() => setParam("page", String(clampedPage + 1))}
                className={`${SECONDARY_BUTTON} border-border-strong bg-surface px-3 text-fg-muted disabled:opacity-40`}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
