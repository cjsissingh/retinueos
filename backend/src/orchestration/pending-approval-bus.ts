import { EventEmitter } from "node:events";
import type { DrizzleDb } from "../db/client.js";
import type { ToolCallRow } from "../db/schema.js";
import { listToolCallsByStatus } from "../tool-calls/tool-call-repo.js";

const CHANNEL = "pending";

/**
 * Workspace-wide pending-approval snapshots. Distinct from JobEventBus,
 * which is per-job and is what a chat's transcript stream already uses:
 * the Approvals page, nav badge, and roster cards need to hear about a
 * resolve that happened on another device or in another view, and those
 * surfaces are not subscribed to any one job.
 */
export class PendingApprovalBus {
  private emitter = new EventEmitter();

  constructor() {
    // One process can have many dashboard tabs open, each holding an SSE
    // connection. The default EventEmitter warning at 10 listeners would
    // fire on a perfectly healthy house with a few browsers.
    this.emitter.setMaxListeners(0);
  }

  publish(items: ToolCallRow[]): void {
    // Same isolation as JobEventBus.publish: one throwing UI stream must
    // not prevent the remaining observers from seeing the snapshot.
    for (const listener of this.emitter.listeners(CHANNEL)) {
      try {
        listener(items);
      } catch (error) {
        console.error("PendingApprovalBus listener failed:", error);
      }
    }
  }

  subscribe(handler: (items: ToolCallRow[]) => void): () => void {
    this.emitter.on(CHANNEL, handler);
    return () => {
      this.emitter.off(CHANNEL, handler);
    };
  }
}

export const defaultPendingApprovalBus = new PendingApprovalBus();

/**
 * Re-reads the current pending_approval rows and publishes that snapshot.
 * Fire-and-forget relative to the mutation that just committed: a failed
 * broadcast must not fail the approve/reject/cancel that already wrote.
 */
export async function broadcastPendingApprovals(
  db: DrizzleDb,
  bus: PendingApprovalBus = defaultPendingApprovalBus,
): Promise<void> {
  try {
    bus.publish(await listToolCallsByStatus(db, "pending_approval"));
  } catch (error) {
    console.error("failed to broadcast pending approvals:", error);
  }
}
