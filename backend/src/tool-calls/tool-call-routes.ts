import { Hono } from "hono";
import type { DrizzleDb } from "../db/client.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { getToolCall, listToolCallsByStatus, listToolCallsByJob, listAllToolCalls } from "./tool-call-repo.js";
import { ApprovalService } from "../control/approval-service.js";
import { ControlError } from "../control/types.js";
import { getJob } from "../jobs/job-repo.js";
import { getPersona, updatePersona } from "../personas/persona-repo.js";
import { persistAlwaysAllow } from "../tools/autonomy.js";

const owner = { kind: "owner", source: "rest" } as const;

export function toolCallRoutes(
  db: DrizzleDb,
  _checkpointer?: BaseCheckpointSaver,
  approvalService?: ApprovalService,
): Hono {
  const service = approvalService ?? new ApprovalService(db);
  const app = new Hono();

  // The audit trail (05-job-creation-and-audit-ui.md): with no `status`
  // filter this now returns every tool_calls row — pending, approved,
  // rejected, executed, and failed — not just what's waiting on the user.
  // `?status=pending_approval` (what the Approvals page uses) and
  // `?jobId=` (a job detail page's full call history) still narrow it.
  app.get("/", async (c) => {
    const status = c.req.query("status");
    const jobId = c.req.query("jobId");
    if (jobId) return c.json(await listToolCallsByJob(db, jobId));
    if (status) return c.json(await listToolCallsByStatus(db, status));
    return c.json(await listAllToolCalls(db));
  });

  app.get("/:id", async (c) => {
    const tc = await getToolCall(db, c.req.param("id"));
    if (!tc) return c.json({ error: "tool call not found" }, 404);
    return c.json(tc);
  });

  async function resolve(id: string, decision: "approve" | "reject") {
    try {
      return { data: await service.resolve(owner, id, decision, crypto.randomUUID()) } as const;
    } catch (error) {
      if (error instanceof ControlError && error.category === "not_found")
        return { error: error.message, status: 404 } as const;
      if (
        error instanceof ControlError &&
        (error.category === "conflict" || error.category === "idempotency_conflict")
      ) {
        return { error: error.message, status: 409 } as const;
      }
      return { error: "internal server error", status: 500 } as const;
    }
  }

  app.post("/:id/approve", async (c) => {
    const result = await resolve(c.req.param("id"), "approve");
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data);
  });

  app.post("/:id/reject", async (c) => {
    const result = await resolve(c.req.param("id"), "reject");
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data);
  });

  // Always allow this tool for the persona, then approve the pending call.
  // Stored on the persona (not the job), so the next chat turn or routine
  // run skips the Ask prompt. Destructive tools cannot be Always-allowed.
  app.post("/:id/always-allow", async (c) => {
    const id = c.req.param("id");
    const tc = await getToolCall(db, id);
    if (!tc) return c.json({ error: "tool call not found" }, 404);

    const job = await getJob(db, tc.jobId);
    if (!job) return c.json({ error: "job not found" }, 404);
    const persona = await getPersona(db, job.personaId);
    if (!persona) return c.json({ error: "persona not found" }, 404);

    if (tc.riskClass === "destructive") {
      return c.json({ error: "destructive tools cannot be always allowed" }, 400);
    }
    if (tc.riskClass !== "read_only" && tc.riskClass !== "reversible") {
      return c.json({ error: "destructive tools cannot be always allowed" }, 400);
    }

    const next = persistAlwaysAllow(persona.assignedToolIds, tc.toolId, tc.riskClass);
    if (!next) {
      return c.json({ error: "tool is not assigned to this persona" }, 409);
    }
    await updatePersona(db, persona.id, { assignedToolIds: next });

    const result = await resolve(id, "approve");
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json(result.data);
  });

  return app;
}
