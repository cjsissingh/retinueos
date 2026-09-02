import { describe, it, expect } from "vitest";
import { originAllowsTool } from "../src/tools/job-origin-policy.js";

describe("originAllowsTool", () => {
  it("allows any origin when a tool declares no requiresOrigin", () => {
    expect(originAllowsTool({}, "cron")).toBe(true);
    expect(originAllowsTool({ requiresOrigin: [] }, "delegation")).toBe(true);
  });

  it("allows only the declared origins", () => {
    const spec = { requiresOrigin: ["user" as const] };
    expect(originAllowsTool(spec, "user")).toBe(true);
    expect(originAllowsTool(spec, "cron")).toBe(false);
    expect(originAllowsTool(spec, "delegation")).toBe(false);
    expect(originAllowsTool(spec, "webhook")).toBe(false);
  });
});
