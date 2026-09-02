import { describe, it, expect } from "vitest";
import { PersonaGenerateRequestSchema, PersonaGeneratedDraftSchema } from "../src/personas/persona-generate-schemas.js";

describe("PersonaGenerateRequestSchema", () => {
  it("requires a non-empty description", () => {
    expect(PersonaGenerateRequestSchema.safeParse({ description: "" }).success).toBe(false);
    expect(PersonaGenerateRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an optional seed template slug", () => {
    const result = PersonaGenerateRequestSchema.safeParse({
      description: "Someone to track my reading list",
      seedTemplateSlug: "researcher",
    });
    expect(result.success).toBe(true);
  });
});

describe("PersonaGeneratedDraftSchema", () => {
  it("defaults charter fields and defaultTools when the model omits them", () => {
    const result = PersonaGeneratedDraftSchema.safeParse({
      name: "Nova",
      role: "Reading Coach",
      systemPrompt: "Help track and discuss books.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.voiceNotes).toBe("");
      expect(result.data.defaultTools).toEqual([]);
    }
  });

  it("rejects a draft missing systemPrompt", () => {
    const result = PersonaGeneratedDraftSchema.safeParse({ name: "Nova", role: "Reading Coach" });
    expect(result.success).toBe(false);
  });
});
