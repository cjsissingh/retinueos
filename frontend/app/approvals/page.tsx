"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClient, type Job, type Persona, type ToolCall } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { ApprovalItem } from "@/components/approval-item";
import { PageHeader } from "@/components/page-header";
import { RowSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PAGE_PAD } from "@/lib/touch-layout";
import { usePendingApprovals } from "@/lib/use-pending-approvals";

type LoadState = "loading" | "ready" | "error";

export default function ApprovalsPage() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const { pending } = usePendingApprovals();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const visible = pending.filter((tc) => !dismissed.has(tc.id));

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [jobList, personaList] = await Promise.all([client.listJobs(), client.listPersonas()]);
      setJobs(jobList);
      setPersonas(personaList);
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

  // A newly-arrived pending call may belong to a job this page hasn't listed
  // yet (another tab's chat just hit a gate). Refetch so personaFor can
  // resolve a name instead of rendering "Someone".
  useEffect(() => {
    if (state !== "ready") return;
    if (!pending.some((tc) => !jobs.some((job) => job.id === tc.jobId))) return;
    Promise.all([client.listJobs(), client.listPersonas()]).then(
      ([jobList, personaList]) => {
        setJobs(jobList);
        setPersonas(personaList);
      },
      () => {},
    );
  }, [pending, jobs, state, client]);

  function personaFor(toolCall: ToolCall): Persona | undefined {
    const job = jobs.find((j) => j.id === toolCall.jobId);
    return job ? personas.find((p) => p.id === job.personaId) : undefined;
  }

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={visible.length > 0 ? `${visible.length} waiting` : "Decisions"}
        title="Approvals"
        description="Review the actions your staff cannot take without you."
      />

      {state === "error" && <ErrorState detail="GET /jobs failed. Nothing has been lost." onRetry={load} />}

      {state === "loading" && (
        <div className="flex max-w-[820px] flex-col gap-4">
          <RowSkeleton />
          <RowSkeleton />
        </div>
      )}

      {state === "ready" && visible.length === 0 && (
        <EmptyState title="You’re all caught up" description="Nothing is waiting for your approval." />
      )}

      {state === "ready" && visible.length > 0 && (
        <div className="flex max-w-[820px] flex-col gap-4">
          {visible.map((tc) => (
            <ApprovalItem
              key={tc.id}
              client={client}
              toolCall={tc}
              persona={personaFor(tc)}
              onResolved={(id) => setDismissed((prev) => new Set(prev).add(id))}
            />
          ))}
        </div>
      )}
    </main>
  );
}
