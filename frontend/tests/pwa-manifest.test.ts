import { describe, expect, it } from "vitest";
import manifest from "../app/manifest.js";

describe("PWA manifest", () => {
  it("opts into display_override alongside the display fallback", () => {
    const result = manifest();
    expect(result.display).toBe("standalone");
    expect(result.display_override).toEqual(["standalone"]);
  });

  it("lands on Today and exposes the Ask and Approvals shortcuts", () => {
    const result = manifest();
    expect(result.start_url).toBe("/today");
    expect(result.shortcuts).toEqual([
      { name: "Ask someone to…", url: "/today?ask=1" },
      { name: "Approvals", url: "/approvals" },
    ]);
  });
});
