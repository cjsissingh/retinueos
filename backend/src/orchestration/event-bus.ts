// backend/src/orchestration/event-bus.ts
import { EventEmitter } from "node:events";
import type { DrizzleDb } from "../db/client.js";
import { recordJobEvent } from "./job-event-repo.js";

export type JobEvent =
  | { type: "status"; status: string }
  | { type: "model_end"; content: string | null }
  | { type: "tool_call"; toolId: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; toolId: string; result: Record<string, unknown> }
  | { type: "delegation_start"; childJobId: string; targetPersonaId: string; task: string }
  | { type: "delegation_end"; childJobId: string; status: string };

export class JobEventBus {
  private emitter = new EventEmitter();
  private db: DrizzleDb | undefined;
  // Serializes durable writes so their insert order matches publish() call
  // order even though nothing awaits them synchronously (see setPersistence).
  private persistQueue: Promise<unknown> = Promise.resolve();

  /**
   * Opts this bus into durably logging every published event to the
   * job_events table (job-event-repo.ts's recordJobEvent), enabling
   * stream-routes.ts's reconnect replay. Not required — a bus with no db
   * (the default for tests and any ad hoc `new JobEventBus()`) behaves
   * exactly as before: live delivery only, nothing persisted.
   */
  setPersistence(db: DrizzleDb): void {
    this.db = db;
  }

  /**
   * Resolves once every persist write currently chained on this bus has
   * finished (success or logged failure). Tests that assert on job_events
   * after publish() must await this instead of a fixed sleep — under CI
   * load a 50ms delay is not always enough, and reconnect replay then
   * looks like a first connect (no backlog).
   */
  flushPersistence(): Promise<void> {
    return Promise.resolve(this.persistQueue).then(() => undefined);
  }

  publish(jobId: string, event: JobEvent): void {
    // EventEmitter stops dispatching as soon as one listener throws. A UI
    // stream (or any future observer) must never be able to interrupt job
    // execution or prevent the remaining observers from seeing an event.
    for (const listener of this.emitter.listeners(jobId)) {
      try {
        listener(event);
      } catch (error) {
        console.error(`JobEventBus listener failed for job ${jobId}:`, error);
      }
    }
    // Fire-and-forget relative to this call (publish() stays synchronous so
    // none of its many call sites need to change), but chained onto the
    // bus's own persistQueue so two events published back-to-back are still
    // written in the order they were published, not whichever insert's
    // connection happens to commit first.
    if (this.db) {
      const db = this.db;
      this.persistQueue = this.persistQueue
        .then(() => recordJobEvent(db, jobId, event))
        .catch((error) => {
          console.error(`JobEventBus failed to persist event for job ${jobId}:`, error);
        });
    }
  }

  subscribe(jobId: string, handler: (event: JobEvent) => void): () => void {
    this.emitter.on(jobId, handler);
    return () => {
      this.emitter.off(jobId, handler);
    };
  }
}

export const defaultJobEventBus = new JobEventBus();
