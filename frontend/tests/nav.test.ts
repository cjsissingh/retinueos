import { describe, expect, it } from "vitest";
import { MOBILE_TABS, MORE_NAV, NAV, PRIMARY_NAV, SETTINGS_NAV } from "../lib/nav.js";

describe("mobile bottom bar", () => {
  it("locks the tab count to exactly five below md", () => {
    // The bug this ticket fixes: the old bar rendered all ten NAV items
    // plus Ask in one row (10px labels on a 390px screen). Five tabs,
    // the fifth opening More instead of routing, is the whole point.
    expect(MOBILE_TABS.length).toBe(5);
  });

  it("orders the four routed tabs Today, Approvals, Chats, Roster, then More", () => {
    expect(MOBILE_TABS.map((tab) => tab.label)).toEqual(["Today", "Approvals", "Chats", "Roster", "More"]);
  });

  it("keeps Ask out of the tab bar entirely -- it floats as a pill instead", () => {
    expect(MOBILE_TABS.some((tab) => tab.label === "Ask")).toBe(false);
  });

  it("makes the fifth tab a sheet trigger, not a route", () => {
    const more = MOBILE_TABS[4];
    expect(more.kind).toBe("more");
    expect(more).not.toHaveProperty("href");
  });
});

describe("More sheet contents", () => {
  it("holds everything the five tabs don't route to directly", () => {
    expect(MORE_NAV.map((item) => item.label)).toEqual([
      "Connections",
      "Scripts",
      "Access",
      "Audit",
      "Logs",
      "Notification settings",
    ]);
  });

  it("doesn't duplicate a route already reachable from a bottom tab", () => {
    const tabHrefs = new Set(MOBILE_TABS.flatMap((tab) => (tab.kind === "link" ? [tab.href] : [])));
    for (const item of MORE_NAV) {
      expect(tabHrefs.has(item.href)).toBe(false);
    }
  });
});

describe("desktop sidebar NAV", () => {
  it("keeps the full desktop list unchanged -- the five-tab collapse is mobile-only", () => {
    expect(NAV.length).toBe(10);
    expect(NAV.map((item) => item.href)).toContain("/settings/notifications");
  });

  it("separates daily work from configuration without changing destinations", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(["Today", "Approvals", "Chats", "Roster", "Logs", "Audit"]);
    expect(SETTINGS_NAV.map((item) => item.label)).toEqual(["Connections", "Scripts", "Access", "Notifications"]);
    expect([...PRIMARY_NAV, ...SETTINGS_NAV]).toEqual(NAV);
  });
});
