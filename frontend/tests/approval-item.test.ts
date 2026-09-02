import { describe, it, expect } from "vitest";
import { describeOutcome } from "../components/approval-item";

describe("describeOutcome", () => {
  it("reports success only for an actually-executed call", () => {
    expect(describeOutcome("executed")).toEqual({ label: "Done.", tone: "success" });
  });

  it("reports failure for a call that actually failed", () => {
    expect(describeOutcome("failed")).toEqual({ label: "It failed.", tone: "danger" });
  });

  it("does not call a still-in-flight approval a failure", () => {
    // Regression test: pollForOutcome gives up after ~6s and can still see
    // "approved" if resumeJob just hasn't finished yet (a real LLM call, a
    // delegation, a slow tool API) -- that used to render as "It failed."
    // even though nothing had actually failed.
    const outcome = describeOutcome("approved");
    expect(outcome.tone).not.toBe("danger");
    expect(outcome.label).not.toMatch(/failed/i);
  });
});
