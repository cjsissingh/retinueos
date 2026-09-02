"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiClient, type Job, type Persona, type ToolCall } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { delegatedChatHref } from "@/lib/chat-navigation";
import { chatTitle } from "@/lib/chat-title";
import { greetingStateLine, greetingWord } from "@/lib/today-greeting";
import {
  collapseAfterFive,
  doneTodayJobs,
  failedTodayCount,
  inFlightJobs,
  relativeTimeFrom,
  workingPersonaCount,
} from "@/lib/today-sections";
import { TODAY_LAYOUT } from "@/lib/today-layout";
import { PRIMARY_BUTTON } from "@/lib/touch-layout";
import { usePendingApprovals } from "@/lib/use-pending-approvals";
import { ApprovalItem } from "@/components/approval-item";
import { TodayComposer } from "@/components/today-composer";
import { PersonaAvatar } from "@/components/persona-avatar";
import { JobStatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { RowSkeleton } from "@/components/ui/skeleton";

type LoadState = "loading" | "ready" | "error";

export default function TodayPage() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [doneExpanded, setDoneExpanded] = useState(false);
  const { pending, revision } = usePendingApprovals();

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [p, j] = await Promise.all([client.listPersonas(), client.listJobs()]);
      setPersonas(p);
      setJobs(j);
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

  // A resolved (or newly pending) approval can flip a job's status --
  // reload so In flight / Done today reflect it without a page refresh.
  useEffect(() => {
    if (revision === 0 || !getStoredPassword()) return;
    client.listJobs().then(setJobs, () => {});
  }, [revision, client]);

  function personaFor(id: string): Persona | undefined {
    return personas.find((p) => p.id === id);
  }

  const now = new Date();
  const needsYou = pending.filter((tc) => !dismissed.has(tc.id));
  const inFlight = useMemo(() => inFlightJobs(jobs), [jobs]);
  const working = workingPersonaCount(inFlight);
  const doneToday = doneTodayJobs(jobs, now);
  const failedToday = failedTodayCount(doneToday);
  const collapsedDone = collapseAfterFive(doneToday);

  const stateLine = greetingStateLine({
    needsYou: needsYou.length,
    working,
    failedToday,
    doneToday: doneToday.length,
  });

  function toolCallJob(tc: ToolCall): Job | undefined {
    return jobs.find((j) => j.id === tc.jobId);
  }

  if (state === "loading") {
    return (
      <main className={TODAY_LAYOUT.page}>
        <RowSkeleton />
        <RowSkeleton />
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className={TODAY_LAYOUT.page}>
        <ErrorState detail="GET /jobs failed. Nothing has been lost." onRetry={load} />
      </main>
    );
  }

  return (
    <main className={TODAY_LAYOUT.page}>
      <div className={TODAY_LAYOUT.greeting}>
        <h1 className="m-0 font-serif text-[28px] leading-[1.15] text-fg">{greetingWord(now)}.</h1>
        <p className="m-0 font-sans text-[15px] text-fg-muted">{stateLine}</p>
      </div>

      {personas.length === 0 ? (
        <EmptyState
          title="Nobody on staff yet"
          description="Hire your first persona, then ask them to do something from here."
          action={
            <Link
              href="/roster"
              className={PRIMARY_BUTTON}
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              Go hire someone
            </Link>
          }
        />
      ) : (
        <TodayComposer client={client} personas={personas} />
      )}

      {needsYou.length > 0 && (
        <section className={TODAY_LAYOUT.section}>
          <h2 className={TODAY_LAYOUT.sectionHeading}>
            Needs you
            <span className={TODAY_LAYOUT.sectionHeadingRule} style={{ background: "var(--border)" }} />
            {/* Amber is design guide's only count-carrying colour. */}
            <span
              className="rounded-badge px-1.5 py-0.5 font-mono text-[11px]"
              style={{ color: "var(--warning-soft-fg)", background: "var(--warning-soft)" }}
            >
              {needsYou.length}
            </span>
            <Link href="/approvals" className="font-sans text-xs font-normal normal-case tracking-normal text-fg-faint">
              See all
            </Link>
          </h2>
          <div className={TODAY_LAYOUT.sectionList}>
            {needsYou.map((tc) => {
              const job = toolCallJob(tc);
              const persona = job ? personaFor(job.personaId) : undefined;
              return (
                <div key={tc.id} className="flex flex-col gap-2">
                  <ApprovalItem
                    client={client}
                    toolCall={tc}
                    persona={persona}
                    onResolved={(id) => setDismissed((prev) => new Set(prev).add(id))}
                  />
                  {job && (
                    <Link
                      href={delegatedChatHref(job)}
                      className="self-start font-mono text-[11px] uppercase tracking-wider"
                      style={{ color: "var(--fg-faint)" }}
                    >
                      Open chat →
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {inFlight.length > 0 && (
        <section className={TODAY_LAYOUT.section}>
          <h2 className={TODAY_LAYOUT.sectionHeading}>
            In flight
            <span className={TODAY_LAYOUT.sectionHeadingRule} style={{ background: "var(--border)" }} />
          </h2>
          <div className={TODAY_LAYOUT.sectionList}>
            {inFlight.map((job) => {
              const persona = personaFor(job.personaId);
              return (
                <Link
                  key={job.id}
                  href={delegatedChatHref(job)}
                  className="flex items-center gap-3 border-b px-1 py-3 no-underline last:border-b-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  {persona && <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-sans text-sm text-fg">
                      {persona?.name ?? "Someone"} &middot; {chatTitle(job)}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-1.5 font-mono text-[11px] text-fg-faint">
                    <i
                      className="status-dot-running inline-block"
                      style={{ width: 6, height: 6, borderRadius: 999, background: "var(--running)" }}
                    />
                    {relativeTimeFrom(job.updatedAt, now)}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {doneToday.length > 0 && (
        <section className={TODAY_LAYOUT.section}>
          <h2 className={TODAY_LAYOUT.sectionHeading}>
            Done today
            <span className={TODAY_LAYOUT.sectionHeadingRule} style={{ background: "var(--border)" }} />
          </h2>
          <div className={TODAY_LAYOUT.sectionList}>
            {(doneExpanded ? doneToday : collapsedDone.visible).map((job) => {
              const persona = personaFor(job.personaId);
              return (
                <Link
                  key={job.id}
                  href={delegatedChatHref(job)}
                  className="flex items-center gap-3 border-b px-1 py-2.5 no-underline opacity-85 last:border-b-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  {persona && <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />}
                  <span className="min-w-0 flex-1 truncate font-sans text-sm text-fg">
                    {persona?.name ?? "Someone"} &middot; {chatTitle(job)}
                  </span>
                  <JobStatusBadge status={job.status} className="flex-none" />
                  <span className="flex-none font-mono text-[11px] text-fg-faint">
                    {relativeTimeFrom(job.updatedAt, now)}
                  </span>
                </Link>
              );
            })}
            {!doneExpanded && collapsedDone.hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setDoneExpanded(true)}
                className="self-start rounded-button border-0 bg-transparent px-0 font-sans text-xs"
                style={{ color: "var(--fg-muted)" }}
              >
                Show {collapsedDone.hiddenCount} more
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
