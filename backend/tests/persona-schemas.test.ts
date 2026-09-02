import { describe, it, expect } from "vitest";
import { PersonaCreateSchema, PersonaUpdateSchema } from "../src/personas/persona-schemas.js";

function baseInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
    ...overrides,
  };
}

describe("PersonaCreateSchema", () => {
  it("accepts a persona with no charter fields and no tools", () => {
    const result = PersonaCreateSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
  });

  it("accepts assignedToolIds with a persona-level autonomy override", () => {
    const result = PersonaCreateSchema.safeParse(
      baseInput({ assignedToolIds: [{ toolId: "calendar_create_event", autonomy: "approval_required" }] }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts assignedToolIds with an explicit Allow / Ask permission", () => {
    const allow = PersonaCreateSchema.safeParse(
      baseInput({ assignedToolIds: [{ toolId: "write_state", permission: "allow" }] }),
    );
    const ask = PersonaCreateSchema.safeParse(
      baseInput({ assignedToolIds: [{ toolId: "write_state", permission: "ask" }] }),
    );
    expect(allow.success).toBe(true);
    expect(ask.success).toBe(true);
  });

  it("rejects Blocked as a stored permission — Blocked is omitting the tool", () => {
    const result = PersonaCreateSchema.safeParse(
      baseInput({ assignedToolIds: [{ toolId: "write_state", permission: "blocked" }] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown autonomy value — there is no way to weaken gating from here", () => {
    const result = PersonaCreateSchema.safeParse(
      baseInput({ assignedToolIds: [{ toolId: "send_email", autonomy: "direct" }] }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts charter fields (voice/boundaries/scope)", () => {
    const result = PersonaCreateSchema.safeParse(
      baseInput({
        voiceNotes: "Dry, understated.",
        boundaries: "Never gives investment advice.",
        scopeDescription: "Household budgeting only.",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a persona with no reportsTo (top of the org chart)", () => {
    const result = PersonaCreateSchema.safeParse(baseInput());
    expect(result.success && result.data.reportsTo).toBeUndefined();
  });

  it("accepts a persona with a reportsTo uuid", () => {
    const result = PersonaCreateSchema.safeParse(baseInput({ reportsTo: "00000000-0000-0000-0000-000000000001" }));
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid reportsTo", () => {
    const result = PersonaCreateSchema.safeParse(baseInput({ reportsTo: "not-a-uuid" }));
    expect(result.success).toBe(false);
  });
});

describe("PersonaUpdateSchema", () => {
  it("accepts a uuid reportsTo", () => {
    const result = PersonaUpdateSchema.safeParse({ reportsTo: "00000000-0000-0000-0000-000000000001" });
    expect(result.success).toBe(true);
  });

  it("accepts null reportsTo (promotes to top of chart)", () => {
    const result = PersonaUpdateSchema.safeParse({ reportsTo: null });
    expect(result.success).toBe(true);
  });

  it("accepts an empty patch — nothing to change is valid, just a no-op", () => {
    const result = PersonaUpdateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a modelProvider/modelName patch", () => {
    const result = PersonaUpdateSchema.safeParse({ modelProvider: "openai", modelName: "gpt-5" });
    expect(result.success).toBe(true);
  });

  it("accepts a model patch alongside a reportsTo patch", () => {
    const result = PersonaUpdateSchema.safeParse({
      modelProvider: "openai",
      modelName: "gpt-5",
      reportsTo: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string modelName", () => {
    const result = PersonaUpdateSchema.safeParse({ modelName: "" });
    expect(result.success).toBe(false);
  });

  it("accepts identity and charter field patches", () => {
    const result = PersonaUpdateSchema.safeParse({
      name: "Renamed",
      role: "New role",
      systemPrompt: "New purpose",
      voiceNotes: "Warmer now",
      boundaries: "Never executes a trade",
      scopeDescription: "Broader scope",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an assignedToolIds patch (full-array replace)", () => {
    const result = PersonaUpdateSchema.safeParse({
      assignedToolIds: [{ toolId: "send_email" }, { toolId: "gmail_search", autonomy: "approval_required" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown autonomy value in an assignedToolIds patch", () => {
    const result = PersonaUpdateSchema.safeParse({
      assignedToolIds: [{ toolId: "send_email", autonomy: "direct" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string name or role", () => {
    expect(PersonaUpdateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(PersonaUpdateSchema.safeParse({ role: "" }).success).toBe(false);
  });
});
