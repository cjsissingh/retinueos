import type { DrizzleDb } from "../db/client.js";
import { listControlAuditEvents, type ListControlAuditEventsInput } from "./control-repo.js";
import type { ControlAuditEventRow } from "../db/schema.js";
import { ControlError, type ControlActor, type PageResult } from "./types.js";

/** Authorizes audit inspection while keeping retained audit storage in control-repo. */
export class ControlAuditService {
  constructor(private db: DrizzleDb) {}

  async list(actor: ControlActor, input: ListControlAuditEventsInput = {}): Promise<PageResult<ControlAuditEventRow>> {
    if (actor.kind === "mcp_client" && !actor.scopes.includes("audit:read")) {
      throw new ControlError("insufficient_scope", "missing required scope: audit:read");
    }
    return listControlAuditEvents(this.db, input);
  }
}
