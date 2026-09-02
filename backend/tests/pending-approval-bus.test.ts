import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PendingApprovalBus, broadcastPendingApprovals } from "../src/orchestration/pending-approval-bus.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { createToolCall } from "../src/tool-calls/tool-call-repo.js";
import { toolCalls } from "../src/db/schema.js";
import { useTestDb } from "./setup/db.js";

describe("PendingApprovalBus", () => {
  it("isolates a throwing subscriber and continues delivering to the others", () => {
    const bus = new PendingApprovalBus();
    const received: number[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    bus.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    bus.subscribe((items) => received.push(items.length));

    try {
      expect(() => bus.publish([])).not.toThrow();
      expect(received).toEqual([0]);
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("broadcastPendingApprovals", () => {
  const { db } = useTestDb();

  it("publishes the current pending_approval rows and omits resolved ones", async () => {
    const bus = new PendingApprovalBus();
    const received: string[][] = [];
    const unsubscribe = bus.subscribe((items) => received.push(items.map((item) => item.id)));

    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    const pending = await createToolCall(db(), {
      jobId: job.id,
      toolId: "send_email",
      riskClass: "destructive",
      arguments: { to: "a@b.com" },
    });
    const resolved = await createToolCall(db(), {
      jobId: job.id,
      toolId: "write_state",
      riskClass: "reversible",
      arguments: { key: "notes", content: "x" },
      status: "approved",
    });

    try {
      await broadcastPendingApprovals(db(), bus);
      expect(received.at(-1)).toEqual([pending.id]);
      expect(received.at(-1)).not.toContain(resolved.id);

      await db().update(toolCalls).set({ status: "approved" }).where(eq(toolCalls.id, pending.id));
      await broadcastPendingApprovals(db(), bus);
      expect(received.at(-1)).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
