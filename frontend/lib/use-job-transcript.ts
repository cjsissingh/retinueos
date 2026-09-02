import { useEffect, useRef, useState } from "react";
import type { ApiClient, Job } from "./api-client";
import type { TranscriptEntry } from "@/components/transcript-row";

/**
 * Live SSE transcript for one job — factored out of the original
 * /logs/[jobId] page so the persona chat page can drive an in-progress
 * chat's live activity the same way, instead of a second hand-rolled copy
 * of this event-parsing logic. `ready` gates the subscription (both
 * callers only want to connect once their own initial load has settled).
 *
 * `onJobUpdate`/`onToolCallsChanged` are callbacks rather than this hook
 * owning that state itself: the two callers keep job/tool-call state
 * differently (a single job vs. a whole persona's job list), so this hook
 * only owns what's genuinely shared -- the transcript entries themselves.
 */
export function useJobTranscript(
  client: ApiClient,
  job: Job | null,
  ready: boolean,
  onJobUpdate: (job: Job) => void,
  onToolCallsChanged?: () => void,
): TranscriptEntry[] {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const entryId = useRef(0);
  const jobId = job?.id;
  const status = job?.status;

  // A freshly selected chat starts from an empty live-activity log, not
  // whatever the previous one left behind.
  useEffect(() => {
    setTranscript([]);
  }, [jobId]);

  useEffect(() => {
    if (!ready || !jobId) return;
    const unsubscribe = client.streamJob(jobId, (event) => {
      // SAFETY: `event` is the backend's JobEvent wire format
      // (orchestration/event-bus.ts), which streamJob deliberately leaves
      // unparsed (Record<string, unknown>) since its shape varies by
      // `type`; `.type` is that union's own discriminant field, always one
      // of TranscriptEntry["kind"]'s members when it's set at all.
      const kind = (event.type as TranscriptEntry["kind"]) ?? "unknown";
      setTranscript((prev) => [...prev, { key: `e${entryId.current++}`, kind, at: Date.now(), data: event }]);
      // A status event only carries the new status string, not `error`/
      // `transcript` (set separately on the row -- see job-repo.ts).
      // Patching just the status field in place would show "failed" with
      // no reason, or a finished chat missing its own last reply, until
      // the next full reload. Refetch instead.
      if (kind === "status" && typeof event.status === "string") {
        client.getJob(jobId).then(onJobUpdate, () => {});
      }
      if (kind === "tool_result" || kind === "status") {
        onToolCallsChanged?.();
      }
    });
    return unsubscribe;
    // `status` is a real dependency, not just an exhaustive-deps
    // placation: stream-routes.ts ends the SSE response (and streamJob
    // closes the EventSource) once a job goes terminal, so a chat that
    // gets CONTINUED after that -- status flips back to "running" on the
    // same job id -- has nothing subscribed to it unless this effect
    // re-runs. Without this, a continued chat's reply only ever shows up
    // after a manual reload, same "black hole" this hook exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, jobId, status]);

  return transcript;
}
