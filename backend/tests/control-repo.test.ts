import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { controlAuditEvents, controlOperations } from "../src/db/schema.js";
import {
  actorKey,
  claimControlOperation,
  completeControlOperation,
  createControlAuditEvent,
  failControlOperation,
  listControlAuditEvents,
  settleControlAuditEvent,
} from "../src/control/control-repo.js";
import type { ControlActor } from "../src/control/types.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();

const owner: ControlActor = { kind: "owner", source: "rest" };
const client: ControlActor = { kind: "mcp_client", clientId: "client-1", scopes: ["routines:write"] };
const persona: ControlActor = {
  kind: "persona",
  personaId: "persona-1",
  jobId: "job-1",
  toolCallId: "tool-call-1",
};

describe("control operation idempotency", () => {
  it("returns the stored result for an identical completed operation", async () => {
    const first = await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("expected a claimed operation");

    const routineId = randomUUID();
    await completeControlOperation(db(), first.operation.id, { routineId }, "routine", routineId);

    const replay = await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });
    expect(replay).toMatchObject({ kind: "completed", result: { routineId } });
  });

  it("treats nested object key order as identical arguments", async () => {
    await claimControlOperation(db(), owner, "routine.create", "key-1", {
      routine: { name: "Morning", schedule: { hour: 8, minute: 30 } },
    });

    await expect(
      claimControlOperation(db(), owner, "routine.create", "key-1", {
        routine: { schedule: { minute: 30, hour: 8 }, name: "Morning" },
      }),
    ).rejects.toMatchObject({ category: "idempotency_conflict", retryable: true });
  });

  it("rejects a key reused with different arguments", async () => {
    await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });

    await expect(
      claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Evening" }),
    ).rejects.toMatchObject({ category: "idempotency_conflict", retryable: false });
  });

  it("rejects an in-progress replay as retryable", async () => {
    await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });

    await expect(
      claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" }),
    ).rejects.toMatchObject({ category: "idempotency_conflict", retryable: true });
  });

  it("bounds stored completed results to 64 KB", async () => {
    const claimed = await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("expected a claimed operation");

    await completeControlOperation(db(), claimed.operation.id, { output: "x".repeat(65 * 1024) });

    const [operation] = await db()
      .select()
      .from(controlOperations)
      .where(eq(controlOperations.id, claimed.operation.id));
    expect(operation?.result).toMatchObject({ truncated: true, algorithm: "sha256" });
  });

  it("records failed operation categories", async () => {
    const claimed = await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("expected a claimed operation");

    await failControlOperation(db(), claimed.operation.id, "invalid_input");

    const [operation] = await db()
      .select()
      .from(controlOperations)
      .where(eq(controlOperations.id, claimed.operation.id));
    expect(operation).toMatchObject({ status: "failed", errorCategory: "invalid_input" });
  });

  it("rejects a matching replay of a failed operation as terminal", async () => {
    const claimed = await claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed") throw new Error("expected a claimed operation");
    await failControlOperation(db(), claimed.operation.id, "invalid_input");

    await expect(
      claimControlOperation(db(), owner, "routine.create", "key-1", { name: "Morning" }),
    ).rejects.toMatchObject({
      category: "conflict",
      retryable: false,
      message: "idempotency operation previously failed; use a new idempotency key",
    });
  });
});

describe("actorKey", () => {
  it("distinguishes every trusted actor variant", () => {
    expect(new Set([actorKey(owner), actorKey(client), actorKey(persona)])).toEqual(
      new Set(["owner:rest", "mcp_client:client-1", "persona:persona-1:job-1:tool-call-1"]),
    );
  });
});

describe("control audit events", () => {
  it("bounds before and after audit details to 32 KB", async () => {
    const event = await createControlAuditEvent(db(), {
      actor: owner,
      action: "routine.update",
      targetType: "routine",
      targetId: randomUUID(),
      before: { output: "x".repeat(33 * 1024) },
      after: { output: "x".repeat(33 * 1024) },
      outcome: "pending",
    });
    await settleControlAuditEvent(db(), event.id, "succeeded");

    const [stored] = await db().select().from(controlAuditEvents).where(eq(controlAuditEvents.id, event.id));
    expect(stored).toMatchObject({
      outcome: "succeeded",
      before: { truncated: true, algorithm: "sha256" },
      after: { truncated: true, algorithm: "sha256" },
    });
  });

  it("filters audit events by actor, action, and target", async () => {
    const routineId = randomUUID();
    const otherRoutineId = randomUUID();
    const matching = await createControlAuditEvent(db(), {
      actor: client,
      action: "routine.create",
      targetType: "routine",
      targetId: routineId,
      sourceJobId: "job-1",
      sourceToolCallId: "tool-call-1",
      mcpRequestId: "request-1",
      idempotencyKey: "key-1",
      correlationId: "correlation-1",
      outcome: "succeeded",
    });
    await createControlAuditEvent(db(), {
      actor: persona,
      action: "routine.update",
      targetType: "routine",
      targetId: otherRoutineId,
      outcome: "failed",
    });

    const page = await listControlAuditEvents(db(), {
      actor: client,
      action: "routine.create",
      targetType: "routine",
      targetId: routineId,
    });
    expect(page).toMatchObject({ items: [{ id: matching.id, mcpRequestId: "request-1" }], nextCursor: null });
  });

  it("paginates audit events in stable descending order with a capped limit", async () => {
    const events = await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        createControlAuditEvent(db(), {
          actor: owner,
          action: "routine.create",
          targetType: "routine",
          targetId: `routine-${index}`,
          outcome: "succeeded",
        }),
      ),
    );

    const capped = await listControlAuditEvents(db(), { limit: 500 });
    expect(capped.items).toHaveLength(100);
    expect(capped.nextCursor).toBeTruthy();

    const first = await listControlAuditEvents(db(), { limit: 2 });
    const second = await listControlAuditEvents(db(), { limit: 2, cursor: first.nextCursor! });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((event) => event.id)).size).toBe(4);
    expect(first.items.map((event) => event.createdAt.getTime())).toEqual(
      first.items.map((event) => event.createdAt.getTime()).sort((a, b) => b - a),
    );
    expect(events.map((event) => event.id)).toContain(first.items[0]?.id);
  });
});
