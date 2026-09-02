import { describe, expect, it } from "vitest";
import {
  assignedConfigFor,
  configForPermission,
  effectivePermission,
  groupPermission,
  permissionLabel,
  setGroupPermission,
  setToolPermission,
  storedPermission,
} from "../lib/tool-permissions";

describe("storedPermission — legacy rows still load", () => {
  it("maps missing, bare, and approval_required configs onto Blocked / Allow / Ask", () => {
    expect(storedPermission(undefined)).toBe("blocked");
    expect(storedPermission({ toolId: "write_state" })).toBe("allow");
    expect(storedPermission({ toolId: "write_state", autonomy: "approval_required" })).toBe("ask");
    expect(storedPermission({ toolId: "write_state", permission: "allow" })).toBe("allow");
    expect(storedPermission({ toolId: "write_state", permission: "ask" })).toBe("ask");
  });
});

describe("effectivePermission", () => {
  it("keeps Allow / Ask / Blocked for a reversible tool", () => {
    expect(effectivePermission("reversible", undefined)).toBe("blocked");
    expect(effectivePermission("reversible", { toolId: "write_state" })).toBe("allow");
    expect(effectivePermission("reversible", { toolId: "write_state", autonomy: "approval_required" })).toBe("ask");
  });

  it("cannot silently Allow a destructive tool", () => {
    expect(effectivePermission("destructive", { toolId: "send_email" })).toBe("ask");
    expect(effectivePermission("destructive", { toolId: "send_email", permission: "allow" })).toBe("ask");
    expect(configForPermission("send_email", "allow", "destructive")).toEqual({
      toolId: "send_email",
      permission: "ask",
      autonomy: "approval_required",
    });
  });
});

describe("setToolPermission", () => {
  it("writes Allow, Ask, and Blocked onto a persona's assigned-tool map", () => {
    let tools = setToolPermission({}, "write_state", "allow", "reversible");
    expect(tools.write_state).toEqual(assignedConfigFor("write_state", "allow"));
    tools = setToolPermission(tools, "write_state", "ask", "reversible");
    expect(tools.write_state).toEqual(assignedConfigFor("write_state", "ask"));
    tools = setToolPermission(tools, "write_state", "blocked", "reversible");
    expect(tools.write_state).toBeUndefined();
  });
});

describe("groupPermission", () => {
  const read = { id: "get_weather", riskClass: "read_only" as const };
  const write = { id: "write_state", riskClass: "reversible" as const };
  const mail = { id: "send_email", riskClass: "destructive" as const };

  it("reports Always allow, Ask, Blocked, or Custom for a section", () => {
    expect(groupPermission([read, write], {})).toBe("blocked");
    expect(
      groupPermission([read, write], {
        get_weather: assignedConfigFor("get_weather", "allow"),
        write_state: assignedConfigFor("write_state", "allow"),
      }),
    ).toBe("allow");
    expect(
      groupPermission([read, write], {
        get_weather: assignedConfigFor("get_weather", "allow"),
        write_state: assignedConfigFor("write_state", "ask"),
      }),
    ).toBe("custom");
  });

  it("keeps a destructive section on Ask when Always allow is requested", () => {
    const next = setGroupPermission({}, [mail], "allow");
    expect(groupPermission([mail], next)).toBe("ask");
    expect(next.send_email).toEqual(assignedConfigFor("send_email", "ask"));
  });
});

describe("permissionLabel", () => {
  it("names the three user-facing states", () => {
    expect(permissionLabel("allow")).toBe("Always allow");
    expect(permissionLabel("ask")).toBe("Ask");
    expect(permissionLabel("blocked")).toBe("Blocked");
  });
});
