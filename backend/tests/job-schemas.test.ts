import { describe, expect, it } from "vitest";
import { JobContinueSchema, JobCreateSchema } from "../src/jobs/job-schemas.js";

const PERSONA_ID = "00000000-0000-4000-8000-000000000001";

describe("job prompt schemas", () => {
  it("rejects whitespace-only prompts for creation and continuation", () => {
    expect(JobCreateSchema.safeParse({ personaId: PERSONA_ID, prompt: " \n\t " }).success).toBe(false);
    expect(JobContinueSchema.safeParse({ prompt: " \n\t " }).success).toBe(false);
  });

  it("preserves meaningful prompt formatting", () => {
    const prompt = "  Keep this indentation\n";

    expect(JobCreateSchema.parse({ personaId: PERSONA_ID, prompt }).prompt).toBe(prompt);
    expect(JobContinueSchema.parse({ prompt }).prompt).toBe(prompt);
  });

  it("defaults notification intent off and preserves an explicit selection", () => {
    expect(JobCreateSchema.parse({ personaId: PERSONA_ID, prompt: "Run it" }).notifyOnOutcome).toBe(false);
    expect(JobContinueSchema.parse({ prompt: "Continue", notifyOnOutcome: true }).notifyOnOutcome).toBe(true);
  });
});
