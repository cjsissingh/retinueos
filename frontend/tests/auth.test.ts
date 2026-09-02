import { describe, expect, it } from "vitest";
import { safeLoginRedirect } from "../lib/auth";

describe("safeLoginRedirect", () => {
  it("preserves normalized internal destinations", () => {
    expect(safeLoginRedirect("/logs/job-1?tab=details#result")).toBe("/logs/job-1?tab=details#result");
    expect(safeLoginRedirect("/logs/../roster")).toBe("/roster");
  });

  it.each([
    null,
    "javascript:alert(document.domain)",
    "https://evil.example/phish",
    "//evil.example/phish",
    "/\\evil.example/phish",
  ])("falls back for unsafe destination %s", (candidate) => {
    expect(safeLoginRedirect(candidate)).toBe("/today");
  });
});
