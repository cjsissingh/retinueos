import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DrizzleDb } from "../db/client.js";
import { getJob } from "../jobs/job-repo.js";
import { JobEventBus, type JobEvent } from "../orchestration/event-bus.js";
import { listJobEventsAfter } from "../orchestration/job-event-repo.js";
import { defaultPendingApprovalBus, type PendingApprovalBus } from "../orchestration/pending-approval-bus.js";
import { listToolCallsByStatus } from "../tool-calls/tool-call-repo.js";
import type { ToolCallRow } from "../db/schema.js";
import { defaultNotificationBus, type NotificationBus } from "../orchestration/notification-bus.js";
import {
  listNotificationsPage,
  projectNotification,
  type PublicNotification,
} from "../notifications/notification-repo.js";

const TERMINAL = new Set(["done", "failed", "waiting_approval", "cancelled", "timed_out", "outcome_unknown"]);

/**
 * A reconnect cursor is present only on an actual reconnect: `Last-Event-ID`
 * is a header EventSource sends automatically after a dropped connection
 * (never on a brand-new `new EventSource(url)`), and `?after=` is the same
 * thing spelled out explicitly for a non-browser client. Its absence means
 * this is a fresh connection, not a resume — deliberately not defaulting to
 * "replay everything from the start" here, since a job's *historical*
 * transcript/tool-call list already comes from GET /jobs/:id and
 * /tool_calls?jobId=, not from this stream; backfilling the full event log
 * on every ordinary first connect would just duplicate that.
 */
function reconnectCursor(c: {
  req: { header(name: string): string | undefined; query(name: string): string | undefined };
}): number | undefined {
  const raw = c.req.header("Last-Event-ID") ?? c.req.query("after");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function streamRoutes(
  db: DrizzleDb,
  bus: JobEventBus,
  pendingBus: PendingApprovalBus = defaultPendingApprovalBus,
  notificationBus: NotificationBus = defaultNotificationBus,
): Hono {
  const app = new Hono();

  app.get("/notifications/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let resolveDone: () => void;
      let rejectDone: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      let writes = Promise.resolve();
      let snapshotQueued = false;
      let buffered: PublicNotification[] | undefined;

      const enqueue = (items: PublicNotification[]) => {
        writes = writes.then(async () => {
          await stream.writeSSE({ data: JSON.stringify({ type: "notifications", items }) });
        });
        void writes.catch((error) => rejectDone(error instanceof Error ? error : new Error(String(error))));
      };

      const unsubscribe = notificationBus.subscribe((items) => {
        const projected = items.map(projectNotification);
        if (snapshotQueued) enqueue(projected);
        else buffered = projected;
      });
      const abort = () => resolveDone();
      stream.onAbort(abort);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });

      try {
        enqueue((await listNotificationsPage(db, { limit: 50 })).items.map(projectNotification));
        snapshotQueued = true;
        if (buffered) enqueue(buffered);
        await done;
        await writes;
      } finally {
        unsubscribe();
      }
    });
  });

  /**
   * Workspace-level pending-approval snapshots. Unlike /jobs/:id/stream this
   * never ends on its own: EventSource reconnects on drop, and each new
   * connection re-reads the current pending_approval rows so a missed live
   * event cannot leave the badge or Approvals list stuck.
   */
  app.get("/pending_approvals/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let resolveDone: () => void;
      let rejectDone: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      let writes = Promise.resolve();
      let snapshotQueued = false;
      let buffered: ToolCallRow[] | undefined;

      const enqueue = (items: ToolCallRow[]) => {
        writes = writes.then(async () => {
          await stream.writeSSE({ data: JSON.stringify({ type: "pending", items }) });
        });
        void writes.catch((error) => rejectDone(error instanceof Error ? error : new Error(String(error))));
      };

      const unsubscribe = pendingBus.subscribe((items) => {
        if (snapshotQueued) enqueue(items);
        else buffered = items;
      });

      const abort = () => resolveDone();
      stream.onAbort(abort);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });

      try {
        enqueue(await listToolCallsByStatus(db, "pending_approval"));
        snapshotQueued = true;
        if (buffered) enqueue(buffered);
        await done;
        await writes;
      } finally {
        unsubscribe();
      }
    });
  });

  app.get("/jobs/:id/stream", async (c) => {
    const jobId = c.req.param("id");
    const job = await getJob(db, jobId);
    if (!job) return c.json({ error: "job not found" }, 404);
    const afterId = reconnectCursor(c);

    return streamSSE(c, async (stream) => {
      let resolveDone: () => void;
      let rejectDone: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      let writes = Promise.resolve();
      let snapshotQueued = false;
      const bufferedEvents: JobEvent[] = [];

      // `id` becomes this message's SSE `id:` field -- present only for
      // durably-persisted backlog rows (job_events.id), so a *subsequent*
      // reconnect can resume from exactly there. Live events published
      // during this connection are sent without one: JobEventBus.publish is
      // fire-and-forget relative to its own persistence write (see
      // event-bus.ts), so this handler has no way to know a live event's
      // row id at the moment it arrives.
      const enqueue = (event: JobEvent, id?: number) => {
        // One promise chain serializes the backlog, snapshot, and all live
        // events. Concurrent writeSSE calls can otherwise reorder payloads
        // or let a terminal write race stream closure.
        writes = writes.then(async () => {
          await stream.writeSSE({ data: JSON.stringify(event), id: id?.toString() });
          if (event.type === "status" && TERMINAL.has(event.status)) resolveDone();
        });
        void writes.catch((error) => rejectDone(error instanceof Error ? error : new Error(String(error))));
      };

      const unsubscribe = bus.subscribe(jobId, (event: JobEvent) => {
        if (snapshotQueued) enqueue(event);
        else bufferedEvents.push(event);
      });

      try {
        // Subscribed above before reading anything, same reasoning as the
        // snapshot read below: whatever commits in the gap is either caught
        // by this backlog query or lands in bufferedEvents live.
        if (afterId !== undefined) {
          for (const row of await listJobEventsAfter(db, jobId, afterId)) {
            // SAFETY: job_events.event is only ever written by
            // JobEventBus.publish (event-bus.ts), whose own parameter type
            // is JobEvent -- this table has no other writer.
            enqueue(row.event as JobEvent, row.id);
          }
        }

        // Subscribe before refreshing the snapshot. If the job settles in
        // the gap after the route's 404 check, either the event is buffered
        // above or this second read observes the terminal database state.
        const latest = (await getJob(db, jobId)) ?? job;
        enqueue({ type: "status", status: latest.status });
        snapshotQueued = true;

        // A terminal snapshot is newer than every event buffered before its
        // read completed, so replaying older statuses afterward could regress
        // the client from done back to running. Nonterminal snapshots still
        // need all buffered events: one may be the terminal transition that
        // committed just after the SELECT's statement snapshot was taken.
        if (!TERMINAL.has(latest.status)) {
          for (const event of bufferedEvents) enqueue(event);
        }

        await done;
        await writes;
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
