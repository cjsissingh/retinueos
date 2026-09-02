import { describe, expect, it } from "vitest";
import { derivePersonaStatus, jobStatusLabel } from "@/components/status-badge";

describe("derivePersonaStatus", () => {
  it("treats a queued job as active work", () => {
    expect(derivePersonaStatus([{ personaId: "persona-1", status: "queued" }], "persona-1")).toBe("on_it");
  });

  it("exposes the same readable label used by the status badge", () => {
    expect(jobStatusLabel("waiting_approval")).toBe("Waiting for approval");
    expect(jobStatusLabel("outcome_unknown")).toBe("Check outcome");
  });
});
