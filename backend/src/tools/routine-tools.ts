import { RoutineService } from "../control/routine-service.js";
import type { ControlActor } from "../control/types.js";
import { RoutineCreateSchema, RoutineUpdateSchema } from "../personas/routine-schemas.js";
import type { ToolContext, ToolSpec } from "./registry.js";

function requireContext(ctx: ToolContext | undefined, toolId: string): ToolContext {
  if (!ctx)
    throw new Error(
      `${toolId} requires tool context (personaId, jobId, toolCallId, db) — not available in this execution path`,
    );
  return ctx;
}

function actorFor(ctx: ToolContext): ControlActor {
  return {
    kind: "persona",
    personaId: ctx.personaId,
    jobId: ctx.jobId,
    toolCallId: ctx.toolCallId,
  };
}

function idempotencyKeyFor(ctx: ToolContext): string {
  return `${ctx.personaId}:${ctx.jobId}:${ctx.toolCallId}`;
}

const routineIdParameters = {
  type: "object",
  properties: { routineId: { type: "string" } },
  required: ["routineId"],
};

export function routineToolSpecs(service: RoutineService): ToolSpec[] {
  return [
    {
      id: "list_own_routines",
      riskClass: "read_only",
      description: "List your own scheduled routines.",
      parameters: { type: "object", properties: {} },
      run: async (_args, ctx) => {
        const c = requireContext(ctx, "list_own_routines");
        return { routines: await service.listAll(actorFor(c)) };
      },
    },
    {
      id: "create_own_routine",
      riskClass: "reversible",
      description: "Create a routine for yourself that runs on a cron schedule.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          cronSchedule: { type: "string" },
          promptTemplate: { type: "string" },
          notifyRoutineRan: { type: "boolean" },
          kind: { type: "string", enum: ["job", "digest"] },
        },
        required: ["name", "cronSchedule", "promptTemplate"],
      },
      run: async (args, ctx) => {
        const c = requireContext(ctx, "create_own_routine");
        const input = RoutineCreateSchema.parse(args);
        return { routine: await service.create(actorFor(c), c.personaId, input, idempotencyKeyFor(c)) };
      },
    },
    {
      id: "update_own_routine",
      riskClass: "reversible",
      description: "Update one of your own routines.",
      parameters: {
        type: "object",
        properties: {
          routineId: { type: "string" },
          name: { type: "string" },
          cronSchedule: { type: "string" },
          promptTemplate: { type: "string" },
          notifyRoutineRan: { type: "boolean" },
          enabled: { type: "boolean" },
          kind: { type: "string", enum: ["job", "digest"] },
        },
        required: ["routineId"],
      },
      run: async (args, ctx) => {
        const c = requireContext(ctx, "update_own_routine");
        const routineId = args.routineId;
        if (typeof routineId !== "string") throw new Error("update_own_routine requires routineId");
        const patch = RoutineUpdateSchema.parse(args);
        return { routine: await service.update(actorFor(c), routineId, patch, idempotencyKeyFor(c)) };
      },
    },
    {
      id: "pause_own_routine",
      riskClass: "reversible",
      description: "Pause one of your own routines.",
      parameters: routineIdParameters,
      run: async (args, ctx) => {
        const c = requireContext(ctx, "pause_own_routine");
        const routineId = requiredRoutineId(args, "pause_own_routine");
        return { routine: await service.pause(actorFor(c), routineId, idempotencyKeyFor(c)) };
      },
    },
    {
      id: "resume_own_routine",
      riskClass: "reversible",
      description: "Resume one of your own routines.",
      parameters: routineIdParameters,
      run: async (args, ctx) => {
        const c = requireContext(ctx, "resume_own_routine");
        const routineId = requiredRoutineId(args, "resume_own_routine");
        return { routine: await service.resume(actorFor(c), routineId, idempotencyKeyFor(c)) };
      },
    },
    {
      id: "run_own_routine_now",
      riskClass: "reversible",
      description: "Run one of your own routines immediately.",
      parameters: routineIdParameters,
      run: async (args, ctx) => {
        const c = requireContext(ctx, "run_own_routine_now");
        await service.runNow(actorFor(c), requiredRoutineId(args, "run_own_routine_now"), idempotencyKeyFor(c));
        return { status: "queued" };
      },
    },
    {
      id: "delete_own_routine",
      riskClass: "destructive",
      description: "Permanently delete one of your own routines.",
      parameters: routineIdParameters,
      run: async (args, ctx) => {
        const c = requireContext(ctx, "delete_own_routine");
        await service.delete(actorFor(c), requiredRoutineId(args, "delete_own_routine"), idempotencyKeyFor(c));
        return { status: "deleted" };
      },
    },
  ];
}

function requiredRoutineId(args: Record<string, unknown>, toolId: string): string {
  if (typeof args.routineId !== "string") throw new Error(`${toolId} requires routineId`);
  return args.routineId;
}
