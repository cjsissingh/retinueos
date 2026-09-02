import {
  claimControlOperation,
  completeControlOperation,
  createControlAuditEvent,
  failControlOperation,
  markControlAuditEventReconciliationPending,
  markControlOperationReconciliationPending,
  settleControlAuditEvent,
} from "./control-repo.js";
import { ControlError, type ControlActor, type PageRequest, type PageResult } from "./types.js";
import type { DrizzleDb } from "../db/client.js";
import type { RoutineRow } from "../db/schema.js";
import { getPersona } from "../personas/persona-repo.js";
import {
  createRoutine,
  deleteRoutineInTransaction,
  getRoutine,
  listRoutines,
  listRoutinesByPersona,
  updateRoutine,
  type RoutineQueryable,
} from "../personas/routine-repo.js";
import type { RoutineCreateInput, RoutineUpdateInput } from "../personas/routine-schemas.js";
import type { SchedulerHandle } from "../orchestration/scheduler.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type RoutineMutation = "create" | "update" | "pause" | "resume" | "run" | "delete";
type RoutineCreateRequest = RoutineCreateInput & { enabled?: boolean };

interface MutationResult<T> {
  result: T;
  operationResult: Record<string, unknown>;
  targetId: string;
  before?: RoutineRow;
  after?: RoutineRow;
}

interface ReconciliationRecovery {
  auditEventId: string;
  operationResult: Record<string, unknown>;
}

class SchedulerReconciliationRequired extends Error {
  constructor() {
    super("routine scheduler reconciliation required");
  }
}

function hasScope(actor: ControlActor, scope: "routines:read" | "routines:write"): boolean {
  return actor.kind !== "mcp_client" || actor.scopes.includes(scope);
}

function requireScope(actor: ControlActor, scope: "routines:read" | "routines:write"): void {
  if (!hasScope(actor, scope)) {
    throw new ControlError("insufficient_scope", `missing required scope: ${scope}`);
  }
}

function actionFor(mutation: RoutineMutation): `routine.${RoutineMutation}` {
  return `routine.${mutation}`;
}

function replayRoutine(result: Record<string, unknown>): RoutineRow {
  const routine = result.routine;
  if (routine === null || typeof routine !== "object" || Array.isArray(routine)) {
    throw new ControlError("internal", "completed routine operation is missing its routine result", true);
  }
  // SAFETY: Successful routine mutations persist a full RoutineRow in the
  // operation result. This branch validates that the JSON value is an object.
  return routine as RoutineRow;
}

function reconciliationRecovery(result: Record<string, unknown>): ReconciliationRecovery {
  const auditEventId = result.auditEventId;
  const operationResult = result.operationResult;
  if (
    typeof auditEventId !== "string" ||
    operationResult === null ||
    typeof operationResult !== "object" ||
    Array.isArray(operationResult)
  ) {
    throw new ControlError("internal", "pending routine operation is missing its recovery state", true);
  }
  // SAFETY: The object branch above establishes the bounded JSON result is a
  // record written by markControlOperationReconciliationPending.
  return { auditEventId, operationResult: operationResult as Record<string, unknown> };
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function routineCursor(routine: RoutineRow): string {
  return routine.id;
}

export class RoutineService {
  constructor(
    private db: DrizzleDb,
    private scheduler?: SchedulerHandle,
  ) {}

  async listAll(actor: ControlActor, personaId?: string): Promise<RoutineRow[]> {
    requireScope(actor, "routines:read");
    const effectivePersonaId = actor.kind === "persona" ? actor.personaId : personaId;
    return effectivePersonaId ? listRoutinesByPersona(this.db, effectivePersonaId) : listRoutines(this.db);
  }

  async listPage(actor: ControlActor, page: PageRequest, personaId?: string): Promise<PageResult<RoutineRow>> {
    const routines = (await this.listAll(actor, personaId)).sort((left, right) => left.id.localeCompare(right.id));
    const cursorIndex = page.cursor === undefined ? -1 : routines.findIndex((routine) => routine.id === page.cursor);
    if (page.cursor !== undefined && cursorIndex < 0) {
      throw new ControlError("invalid_input", "invalid routine cursor");
    }
    const items = routines.slice(cursorIndex + 1, cursorIndex + 1 + pageSize(page.limit));
    return {
      items,
      nextCursor:
        cursorIndex + 1 + items.length < routines.length && items.length > 0 ? routineCursor(items.at(-1)!) : null,
    };
  }

  async get(actor: ControlActor, routineId: string): Promise<RoutineRow | undefined> {
    requireScope(actor, "routines:read");
    const routine = await getRoutine(this.db, routineId);
    if (routine && actor.kind === "persona" && routine.personaId !== actor.personaId) {
      throw new ControlError("ownership_violation", "persona actors may only access their own routines");
    }
    return routine;
  }

  async create(
    actor: ControlActor,
    personaId: string,
    input: RoutineCreateRequest,
    idempotencyKey: string,
  ): Promise<RoutineRow> {
    requireScope(actor, "routines:write");
    const effectivePersonaId = actor.kind === "persona" ? actor.personaId : personaId;
    if (!(await getPersona(this.db, effectivePersonaId))) {
      throw new ControlError("not_found", "persona not found");
    }
    const createInput = { ...input, enabled: input.enabled ?? true };
    return this.mutateRoutine(
      actor,
      "create",
      idempotencyKey,
      { personaId: effectivePersonaId, ...createInput },
      async (tx) => {
        const routine = await createRoutine(tx, { personaId: effectivePersonaId, ...createInput });
        return { result: routine, operationResult: { routine }, targetId: routine.id, after: routine };
      },
      replayRoutine,
      (routine) => {
        if (routine.enabled) this.register(routine);
      },
    );
  }

  async update(
    actor: ControlActor,
    routineId: string,
    patch: RoutineUpdateInput,
    idempotencyKey: string,
  ): Promise<RoutineRow> {
    return this.updateAndSchedule(actor, "update", routineId, patch, idempotencyKey);
  }

  async pause(actor: ControlActor, routineId: string, idempotencyKey: string): Promise<RoutineRow> {
    return this.updateAndSchedule(actor, "pause", routineId, { enabled: false }, idempotencyKey);
  }

  async resume(actor: ControlActor, routineId: string, idempotencyKey: string): Promise<RoutineRow> {
    return this.updateAndSchedule(actor, "resume", routineId, { enabled: true }, idempotencyKey);
  }

  async runNow(actor: ControlActor, routineId: string, idempotencyKey: string): Promise<void> {
    await this.mutateRoutine(
      actor,
      "run",
      idempotencyKey,
      { routineId },
      async () => {
        const routine = await this.requireOwnedRoutine(actor, routineId);
        return {
          result: undefined,
          operationResult: { status: "queued" },
          targetId: routine.id,
          before: routine,
          after: routine,
        };
      },
      () => undefined,
      async () => {
        if (!this.scheduler) throw new ControlError("internal", "no scheduler available to run this routine", true);
        await this.scheduler.runNow(routineId);
      },
    );
  }

  async delete(actor: ControlActor, routineId: string, idempotencyKey: string): Promise<void> {
    await this.mutateRoutine(
      actor,
      "delete",
      idempotencyKey,
      { routineId },
      async (tx) => {
        const routine = await this.requireOwnedRoutine(actor, routineId, tx);
        await deleteRoutineInTransaction(tx, routineId);
        return { result: undefined, operationResult: { status: "deleted" }, targetId: routine.id, before: routine };
      },
      () => undefined,
      () => this.unschedule(routineId),
    );
  }

  async reconcileScheduler(): Promise<void> {
    if (this.scheduler) this.scheduler.replaceAll(await listRoutines(this.db));
  }

  private async updateAndSchedule(
    actor: ControlActor,
    mutation: "update" | "pause" | "resume",
    routineId: string,
    patch: RoutineUpdateInput,
    idempotencyKey: string,
  ): Promise<RoutineRow> {
    return this.mutateRoutine(
      actor,
      mutation,
      idempotencyKey,
      { routineId, patch },
      async (tx) => {
        const before = await this.requireOwnedRoutine(actor, routineId, tx);
        const after = await updateRoutine(tx, routineId, patch);
        if (!after) throw new ControlError("not_found", "routine not found");
        return { result: after, operationResult: { routine: after }, targetId: after.id, before, after };
      },
      replayRoutine,
      (routine) => this.reschedule(routine),
    );
  }

  private async mutateRoutine<T>(
    actor: ControlActor,
    mutation: RoutineMutation,
    idempotencyKey: string,
    arguments_: Record<string, unknown>,
    mutate: (tx: RoutineQueryable) => Promise<MutationResult<T>>,
    replay: (result: Record<string, unknown>) => T,
    schedule: (result: T) => void | Promise<void>,
  ): Promise<T> {
    requireScope(actor, "routines:write");
    const claim = await claimControlOperation(this.db, actor, actionFor(mutation), idempotencyKey, arguments_);
    if (claim.kind === "completed") {
      return replay(claim.result);
    }
    if (claim.kind === "reconciliation_pending") {
      return this.retryReconciliation(claim.operation.id, claim.operation.targetId, claim.result, replay);
    }

    let mutationResult: MutationResult<T> | undefined;
    let auditId: string | undefined;
    try {
      const committed = await this.db.transaction(async (tx) => {
        const result = await mutate(tx);
        const audit = await createControlAuditEvent(tx, {
          actor,
          action: actionFor(mutation),
          targetType: "routine",
          targetId: result.targetId,
          idempotencyKey,
          before: result.before ? { routine: result.before } : undefined,
          after: result.after ? { routine: result.after } : undefined,
        });
        return { result, auditId: audit.id };
      });
      mutationResult = committed.result;
      auditId = committed.auditId;
    } catch (error) {
      const controlError = this.controlError(error instanceof Error ? error : new Error("routine operation failed"));
      await failControlOperation(this.db, claim.operation.id, controlError);
      throw controlError;
    }

    try {
      await schedule(mutationResult.result);
    } catch (error) {
      const controlError = await this.schedulerFailure(
        error instanceof Error ? error : new Error("scheduler operation failed"),
      );
      if (controlError.category === "scheduler_reconciliation_pending") {
        await markControlOperationReconciliationPending(
          this.db,
          claim.operation.id,
          { auditEventId: auditId, operationResult: mutationResult.operationResult },
          "routine",
          mutationResult.targetId,
        );
        await markControlAuditEventReconciliationPending(this.db, auditId);
      } else {
        await failControlOperation(this.db, claim.operation.id, controlError);
        await settleControlAuditEvent(this.db, auditId, "failed", controlError.category);
      }
      throw controlError;
    }

    await completeControlOperation(
      this.db,
      claim.operation.id,
      mutationResult.operationResult,
      "routine",
      mutationResult.targetId,
    );
    await settleControlAuditEvent(this.db, auditId, "succeeded");
    return mutationResult.result;
  }

  private async retryReconciliation<T>(
    operationId: string,
    targetId: string | null,
    result: Record<string, unknown>,
    replay: (result: Record<string, unknown>) => T,
  ): Promise<T> {
    const recovery = reconciliationRecovery(result);
    try {
      await this.reconcileScheduler();
    } catch {
      throw new ControlError(
        "scheduler_reconciliation_pending",
        "routine mutation committed but scheduler reconciliation is pending",
        true,
      );
    }
    await completeControlOperation(this.db, operationId, recovery.operationResult, "routine", targetId ?? undefined);
    await settleControlAuditEvent(this.db, recovery.auditEventId, "succeeded");
    return replay(recovery.operationResult);
  }

  private async requireOwnedRoutine(
    actor: ControlActor,
    routineId: string,
    db: RoutineQueryable = this.db,
  ): Promise<RoutineRow> {
    const routine = await getRoutine(db, routineId);
    if (!routine) throw new ControlError("not_found", "routine not found");
    if (actor.kind === "persona" && routine.personaId !== actor.personaId) {
      throw new ControlError("ownership_violation", "persona actors may only mutate their own routines");
    }
    return routine;
  }

  private register(routine: RoutineRow): void {
    if (!this.scheduler) return;
    try {
      this.scheduler.registerAll([routine]);
    } catch {
      throw new SchedulerReconciliationRequired();
    }
    this.scheduler.start();
  }

  private reschedule(routine: RoutineRow): void {
    if (!this.scheduler) return;
    try {
      this.scheduler.reschedule(routine);
    } catch {
      throw new SchedulerReconciliationRequired();
    }
  }

  private unschedule(routineId: string): void {
    if (!this.scheduler) return;
    try {
      this.scheduler.unschedule(routineId);
    } catch {
      throw new SchedulerReconciliationRequired();
    }
  }

  private async schedulerFailure(error: Error): Promise<ControlError> {
    if (error instanceof ControlError && error.message === "no scheduler available to run this routine") return error;
    if (!(error instanceof SchedulerReconciliationRequired)) return this.controlError(error);
    try {
      await this.reconcileScheduler();
    } catch {
      // The mutation is already durable. The next service call or process
      // start can retry reconciliation from the committed routine rows.
    }
    return new ControlError(
      "scheduler_reconciliation_pending",
      "routine mutation committed but scheduler reconciliation is pending",
      true,
    );
  }

  private controlError(error: Error): ControlError {
    if (error instanceof ControlError) return error;
    return new ControlError("internal", "routine operation failed", true);
  }
}
