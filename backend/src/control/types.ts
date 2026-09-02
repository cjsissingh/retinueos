export type ControlScope =
  | "personas:read"
  | "jobs:read"
  | "jobs:write"
  | "routines:read"
  | "routines:write"
  | "approvals:read"
  | "approvals:write"
  | "audit:read";

export type ControlActor =
  | { kind: "owner"; source: "rest" }
  | { kind: "mcp_client"; clientId: string; scopes: ControlScope[] }
  | { kind: "persona"; personaId: string; jobId: string; toolCallId: string };

export type ControlAction =
  | "routine.create"
  | "routine.update"
  | "routine.pause"
  | "routine.resume"
  | "routine.run"
  | "routine.delete"
  | "job.create"
  | "job.continue"
  | "job.retry"
  | "job.cancel"
  | "approval.approve"
  | "approval.reject"
  | "client.create"
  | "client.revoke";

export type ControlTargetType = "routine" | "job" | "tool_call" | "control_client";

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export class ControlError extends Error {
  constructor(
    public category:
      | "invalid_input"
      | "unauthenticated"
      | "insufficient_scope"
      | "ownership_violation"
      | "not_found"
      | "conflict"
      | "idempotency_conflict"
      | "scheduler_reconciliation_pending"
      | "internal",
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
