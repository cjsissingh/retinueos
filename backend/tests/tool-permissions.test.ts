import { describe, it, expect } from "vitest";
import {
  assignedConfigFor,
  configForPermission,
  effectivePermission,
  isGated,
  normalizeAssignedTools,
  persistAlwaysAllow,
  storedPermission,
} from "../src/tools/autonomy.js";
import type { AssignedToolConfig } from "../src/db/schema.js";

function riskForCanonicalize(id: string) {
  return id === "send_email" ? "destructive" : id === "get_weather" ? "read_only" : "reversible";
}

describe("storedPermission — legacy rows still load", () => {
  it("maps a missing config to Blocked", () => {
    expect(storedPermission(undefined)).toBe("blocked");
  });

  it("maps a bare assigned tool (no override) to Allow", () => {
    expect(storedPermission({ toolId: "write_state" })).toBe("allow");
  });

  it("maps autonomy: approval_required to Ask", () => {
    expect(storedPermission({ toolId: "write_state", autonomy: "approval_required" })).toBe("ask");
  });

  it("maps explicit permission fields, with Ask winning over a conflicting autonomy", () => {
    expect(storedPermission({ toolId: "write_state", permission: "allow" })).toBe("allow");
    expect(storedPermission({ toolId: "write_state", permission: "ask" })).toBe("ask");
    expect(storedPermission({ toolId: "write_state", permission: "allow", autonomy: "approval_required" })).toBe("ask");
  });
});

describe("effectivePermission — three states plus the destructive ceiling", () => {
  const reversible = { riskClass: "reversible" as const };
  const destructive = { riskClass: "destructive" as const };

  it("Allow / Ask / Blocked enforce for a reversible tool", () => {
    expect(effectivePermission(reversible, undefined)).toBe("blocked");
    expect(effectivePermission(reversible, { toolId: "write_state" })).toBe("allow");
    expect(effectivePermission(reversible, { toolId: "write_state", autonomy: "approval_required" })).toBe("ask");
    expect(isGated(reversible, { toolId: "write_state" })).toBe(false);
    expect(isGated(reversible, { toolId: "write_state", autonomy: "approval_required" })).toBe(true);
    expect(isGated(reversible, undefined)).toBe(false);
  });

  it("a destructive tool cannot go Allow even when the stored row looks like Allow", () => {
    expect(effectivePermission(destructive, { toolId: "send_email" })).toBe("ask");
    expect(effectivePermission(destructive, { toolId: "send_email", permission: "allow" })).toBe("ask");
    expect(isGated(destructive, { toolId: "send_email" })).toBe(true);
    expect(isGated(destructive, { toolId: "send_email", permission: "allow" })).toBe(true);
  });

  it("an unassigned destructive tool is Blocked, not Ask", () => {
    expect(effectivePermission(destructive, undefined)).toBe("blocked");
    expect(isGated(destructive, undefined)).toBe(false);
  });
});

describe("configForPermission / normalizeAssignedTools", () => {
  it("drops Blocked rather than storing it", () => {
    expect(configForPermission("write_state", "blocked", "reversible")).toBeUndefined();
  });

  it("coerces destructive Allow to Ask so it cannot be stored silently", () => {
    expect(configForPermission("send_email", "allow", "destructive")).toEqual({
      toolId: "send_email",
      permission: "ask",
      autonomy: "approval_required",
    });
  });

  it("canonicalizes a legacy array on write", () => {
    const legacy: AssignedToolConfig[] = [
      { toolId: "write_state" },
      { toolId: "get_weather", autonomy: "approval_required" },
      { toolId: "send_email" },
    ];
    expect(normalizeAssignedTools(legacy, riskForCanonicalize)).toEqual([
      { toolId: "write_state", permission: "allow" },
      { toolId: "get_weather", permission: "ask", autonomy: "approval_required" },
      { toolId: "send_email", permission: "ask", autonomy: "approval_required" },
    ]);
  });
});

describe("persistAlwaysAllow", () => {
  it("flips an assigned Ask tool to Allow", () => {
    const next = persistAlwaysAllow(
      [{ toolId: "write_state", permission: "ask", autonomy: "approval_required" }],
      "write_state",
      "reversible",
    );
    expect(next).toEqual([{ toolId: "write_state", permission: "allow" }]);
  });

  it("refuses destructive tools", () => {
    expect(persistAlwaysAllow([{ toolId: "send_email" }], "send_email", "destructive")).toBeUndefined();
  });

  it("refuses a tool that is not assigned (Blocked)", () => {
    expect(persistAlwaysAllow([], "write_state", "reversible")).toBeUndefined();
  });

  it("leaves sibling tool configs intact", () => {
    const next = persistAlwaysAllow(
      [
        { toolId: "write_state", permission: "ask", autonomy: "approval_required" },
        { toolId: "read_state", permission: "allow" },
      ],
      "write_state",
      "reversible",
    );
    expect(next).toEqual([
      { toolId: "write_state", permission: "allow" },
      { toolId: "read_state", permission: "allow" },
    ]);
  });
});

describe("assignedConfigFor", () => {
  it("keeps the legacy autonomy alias on Ask so older readers still see it", () => {
    expect(assignedConfigFor("write_state", "ask")).toEqual({
      toolId: "write_state",
      permission: "ask",
      autonomy: "approval_required",
    });
  });
});
