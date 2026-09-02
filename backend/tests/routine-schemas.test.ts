import { describe, it, expect } from "vitest";
import { RoutineCreateSchema, RoutineUpdateSchema } from "../src/personas/routine-schemas.js";

function baseInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Morning Digest",
    cronSchedule: "0 8 * * *",
    promptTemplate: "Scan the inbox and calendar, summarize what needs attention.",
    ...overrides,
  };
}

describe("RoutineCreateSchema", () => {
  it("accepts a valid routine", () => {
    const result = RoutineCreateSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
  });

  it("defaults notifyRoutineRan to false", () => {
    const result = RoutineCreateSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.notifyRoutineRan).toBe(false);
  });

  it("rejects an invalid cron expression", () => {
    const result = RoutineCreateSchema.safeParse(baseInput({ cronSchedule: "not a cron schedule" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.cronSchedule?.[0]).toMatch(/cron/i);
    }
  });

  it("rejects an empty promptTemplate", () => {
    const result = RoutineCreateSchema.safeParse(baseInput({ promptTemplate: "" }));
    expect(result.success).toBe(false);
  });
});

describe("RoutineUpdateSchema", () => {
  it("accepts a partial update with just one field", () => {
    const result = RoutineUpdateSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it("rejects an empty body", () => {
    const result = RoutineUpdateSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an invalid cronSchedule when one is provided", () => {
    const result = RoutineUpdateSchema.safeParse({ cronSchedule: "nonsense" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.cronSchedule?.[0]).toMatch(/cron/i);
    }
  });

  it("does not require cronSchedule when updating unrelated fields", () => {
    const result = RoutineUpdateSchema.safeParse({ name: "New name" });
    expect(result.success).toBe(true);
  });

  it("accepts every field at once", () => {
    const result = RoutineUpdateSchema.safeParse({
      name: "New name",
      cronSchedule: "0 9 * * *",
      promptTemplate: "New prompt.",
      notifyRoutineRan: true,
      enabled: false,
    });
    expect(result.success).toBe(true);
  });
});
