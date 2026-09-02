"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { JobDetailView } from "@/components/job-detail-view";
import { ApiClient, ApiError } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { loadJobDetail } from "@/lib/load-job-detail";
import { PAGE_PAD } from "@/lib/touch-layout";
import { useJobTranscript } from "@/lib/use-job-transcript";

type LoadState = "loading" | "ready" | "error" | "not_found";

export default function JobDetailPage() {
  const params = useParams<{ jobId: string }>();
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadJobDetail>> | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const job = detail?.job ?? null;

  const load = useCallback(async () => {
    setState("loading");
    try {
      setDetail(await loadJobDetail(client, params.jobId));
      setState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      if (err instanceof ApiError && err.status === 404) {
        setState("not_found");
        return;
      }
      setState("error");
    }
  }, [client, params.jobId, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  // A tool actually finishing (or the job reaching a terminal status) is
  // when a tool_calls row's result/status could have just changed —
  // refetch so the audit sidebar shows the real outcome, not what was
  // known before the model/approval flow moved.
  const transcript = useJobTranscript(
    client,
    job,
    state === "ready",
    (updatedJob) => setDetail((current) => (current ? { ...current, job: updatedJob } : current)),
    () => {
      if (job) {
        client.listToolCallsForJob(job.id).then(
          (toolCalls) => setDetail((current) => (current ? { ...current, toolCalls } : current)),
          () => {},
        );
      }
    },
  );

  if (state === "loading") {
    return (
      <main className={PAGE_PAD}>
        <p className="font-sans text-sm text-fg-muted">Loading…</p>
      </main>
    );
  }

  if (state === "not_found") {
    return (
      <main className={PAGE_PAD}>
        <EmptyState title="No such job" description="It may have been an ID typo, or it's older than this install." />
      </main>
    );
  }

  if (state === "error" || !detail) {
    return (
      <main className={PAGE_PAD}>
        <ErrorState detail="Couldn't load this job." onRetry={load} />
      </main>
    );
  }

  return <JobDetailView {...detail} transcript={transcript} />;
}
