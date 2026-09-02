import { Hono } from "hono";
import type { ControlActor, ControlTargetType } from "./types.js";
import { ControlError } from "./types.js";
import { ControlAuditService } from "./audit-service.js";
import type { ControlAction } from "./types.js";

const owner = { kind: "owner", source: "rest" } as const;

function parseActor(actorKind: string | undefined, actorId: string | undefined): ControlActor | undefined {
  if (!actorKind && !actorId) return undefined;
  if (!actorKind || !actorId)
    throw new ControlError("invalid_input", "actorKind and actorId must be provided together");
  if (actorKind === "owner" && actorId === "rest") return owner;
  if (actorKind === "mcp_client") return { kind: "mcp_client", clientId: actorId, scopes: [] };
  if (actorKind === "persona")
    return { kind: "persona", personaId: actorId, jobId: "audit-filter", toolCallId: "audit-filter" };
  throw new ControlError("invalid_input", "invalid audit actor");
}

function parseActorFilter(
  value: string | undefined,
  actorKind: string | undefined,
  actorId: string | undefined,
): ControlActor | undefined {
  if (value !== undefined) {
    if (actorKind || actorId) throw new ControlError("invalid_input", "use actor or actorKind and actorId, not both");
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1)
      throw new ControlError("invalid_input", "invalid audit actor");
    return parseActor(value.slice(0, separator), value.slice(separator + 1));
  }
  return parseActor(actorKind, actorId);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ControlError("invalid_input", "invalid audit limit");
  return parsed;
}

function parseEnum<T extends string>(value: string | undefined, values: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  // SAFETY: this widens only for the runtime membership check below; its result is narrowed before return.
  if (!values.includes(value as T)) throw new ControlError("invalid_input", `invalid audit ${name}`);
  // SAFETY: membership in the supplied enum values was checked immediately above.
  return value as T;
}

/** Owner REST adapter. Authentication is applied by createApp before this route. */
export function auditRoutes(service: ControlAuditService): Hono {
  const app = new Hono();
  app.get("/", async (c) => {
    try {
      const page = await service.list(owner, {
        actor: parseActorFilter(c.req.query("actor"), c.req.query("actorKind"), c.req.query("actorId")),
        action: parseEnum(
          c.req.query("action"),
          [
            "routine.create",
            "routine.update",
            "routine.pause",
            "routine.resume",
            "routine.run",
            "routine.delete",
            "job.create",
            "job.continue",
            "job.retry",
            "job.cancel",
            "approval.approve",
            "approval.reject",
            "client.create",
            "client.revoke",
          ] as const satisfies readonly ControlAction[],
          "action",
        ),
        targetType: parseEnum(
          c.req.query("targetType"),
          ["routine", "job", "tool_call", "control_client"] as const satisfies readonly ControlTargetType[],
          "target type",
        ),
        outcome: parseEnum(c.req.query("outcome"), ["pending", "succeeded", "failed"] as const, "outcome"),
        cursor: c.req.query("cursor"),
        limit: parseLimit(c.req.query("limit")),
      });
      return c.json(page);
    } catch (error) {
      if (error instanceof ControlError && error.category === "invalid_input") {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: "internal server error" }, 500);
    }
  });
  return app;
}
