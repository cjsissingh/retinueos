"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiClient, type Job, type Persona } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { delegatedChatHref } from "@/lib/chat-navigation";
import { chatTitle } from "@/lib/chat-title";
import { sortedChatRows } from "@/lib/chat-list";
import { relativeTimeFrom } from "@/lib/today-sections";
import { PersonaAvatar } from "@/components/persona-avatar";
import { JobStatusBadge } from "@/components/status-badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { RowSkeleton } from "@/components/ui/skeleton";
import { LIST_ROW, PAGE_PAD } from "@/lib/touch-layout";
import { usePendingApprovals } from "@/lib/use-pending-approvals";

type LoadState = "loading" | "ready" | "error";

export default function ChatsPage() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const { revision } = usePendingApprovals();

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [j, p] = await Promise.all([client.listJobs(), client.listPersonas()]);
      setJobs(j);
      setPersonas(p);
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

  // A resolved approval can flip a job's status (e.g. off waiting_approval)
  // -- refetch so this list's badges don't go stale.
  useEffect(() => {
    if (revision === 0 || !getStoredPassword()) return;
    client.listJobs().then(setJobs, () => {});
  }, [revision, client]);

  const rows = sortedChatRows(jobs, personas);
  const now = new Date();

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={state === "ready" ? `${rows.length} conversations` : "Conversations"}
        title="Chats"
        description="Follow work in progress and continue earlier conversations."
      />

      {state === "error" && <ErrorState detail="GET /jobs failed. Nothing has been lost." onRetry={load} />}

      {state === "loading" && (
        <div className="flex max-w-[820px] flex-col gap-3">
          <RowSkeleton />
          <RowSkeleton />
        </div>
      )}

      {state === "ready" && rows.length === 0 && (
        <EmptyState title="No chats yet" description="Ask someone to do something and it will show up here." />
      )}

      {state === "ready" && rows.length > 0 && (
        <div className="flex max-w-[820px] flex-col gap-2">
          {rows.map(({ job, persona }) => (
            <Link
              key={job.id}
              href={delegatedChatHref(job)}
              className={`${LIST_ROW} flex items-center gap-3 border-b px-1 py-3 no-underline last:border-b-0`}
              style={{ borderColor: "var(--border)" }}
            >
              {persona && <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-sans text-sm text-fg">
                  {persona?.name ?? "Someone"} &middot; {chatTitle(job)}
                </span>
              </span>
              <JobStatusBadge status={job.status} className="flex-none" />
              <span className="flex-none font-mono text-[11px] text-fg-faint">
                {relativeTimeFrom(job.updatedAt, now)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
