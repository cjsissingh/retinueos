import { describe, expect, it, vi } from "vitest";
import { RoutineService } from "../src/control/routine-service.js";
import type { SchedulerHandle } from "../src/orchestration/scheduler.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createRoutine } from "../src/personas/routine-repo.js";
import { routineToolSpecs } from "../src/tools/routine-tools.js";
import type { ToolContext } from "../src/tools/registry.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();

function context(personaId: string, toolCallId: string): ToolContext {
  return { personaId, jobId: "job-1", toolCallId, db: db() };
}

async function persona(name: string) {
  return createPersona(db(), {
    name,
    role: "R",
    systemPrompt: "S",
    voiceNotes: "",
    boundaries: "",
    scopeDescription: "",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
}

describe("self-scoped routine tools", () => {
  it("exposes the seven routine tools with self-only schemas and risk classes", () => {
    const specs = routineToolSpecs(new RoutineService(db()));

    expect(specs.map(({ id }) => id)).toEqual([
      "list_own_routines",
      "create_own_routine",
      "update_own_routine",
      "pause_own_routine",
      "resume_own_routine",
      "run_own_routine_now",
      "delete_own_routine",
    ]);
    expect(specs.map(({ riskClass }) => riskClass)).toEqual([
      "read_only",
      "reversible",
      "reversible",
      "reversible",
      "reversible",
      "reversible",
      "destructive",
    ]);
    for (const spec of specs) {
      expect((spec.parameters.properties as Record<string, unknown>).personaId).toBeUndefined();
    }
  });

  it("requires trusted execution context for every routine tool", async () => {
    const specs = routineToolSpecs(new RoutineService(db()));

    await Promise.all(
      specs.map((spec) => expect(spec.run({}, undefined)).rejects.toThrow(`${spec.id} requires tool context`)),
    );
  });

  it("uses the context persona for every routine operation and preserves standard result shapes", async () => {
    const self = await persona("Self");
    const other = await persona("Other");
    const runNow = vi.fn(async (_routineId: string) => undefined);
    const scheduler: SchedulerHandle = {
      registerAll: vi.fn(),
      replaceAll: vi.fn(),
      start: vi.fn(),
      unschedule: vi.fn(),
      reschedule: vi.fn(),
      runNow,
    };
    const specs = routineToolSpecs(new RoutineService(db(), scheduler));
    const tool = (id: string) => specs.find((spec) => spec.id === id)!;

    expect(await tool("list_own_routines").run({}, context(self.id, "list-empty"))).toEqual({ routines: [] });
    const created = await tool("create_own_routine").run(
      { name: "Morning", cronSchedule: "0 8 * * *", promptTemplate: "Review today." },
      context(self.id, "create"),
    );
    expect(created).toMatchObject({ routine: { personaId: self.id, enabled: true, kind: "job" } });
    const routineId = (created.routine as { id: string }).id;

    expect(await tool("list_own_routines").run({}, context(self.id, "list"))).toMatchObject({
      routines: [expect.objectContaining({ id: routineId })],
    });
    expect(
      await tool("update_own_routine").run({ routineId, name: "Updated" }, context(self.id, "update")),
    ).toMatchObject({ routine: { id: routineId, name: "Updated" } });
    expect(await tool("pause_own_routine").run({ routineId }, context(self.id, "pause"))).toMatchObject({
      routine: { id: routineId, enabled: false },
    });
    expect(await tool("resume_own_routine").run({ routineId }, context(self.id, "resume"))).toMatchObject({
      routine: { id: routineId, enabled: true },
    });
    expect(await tool("run_own_routine_now").run({ routineId }, context(self.id, "run"))).toEqual({ status: "queued" });
    expect(runNow).toHaveBeenCalledWith(routineId);
    expect(await tool("delete_own_routine").run({ routineId }, context(self.id, "delete"))).toEqual({
      status: "deleted",
    });

    const otherRoutine = await createRoutine(db(), {
      personaId: other.id,
      name: "Private",
      cronSchedule: "0 9 * * *",
      promptTemplate: "Do not touch.",
    });
    await expect(
      tool("update_own_routine").run({ routineId: otherRoutine.id, name: "Stolen" }, context(self.id, "other-update")),
    ).rejects.toMatchObject({ category: "ownership_violation" });
  });
});
