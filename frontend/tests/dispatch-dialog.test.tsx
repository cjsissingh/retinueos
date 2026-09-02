import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationIntentControl, notificationDeviceHint } from "../components/notification-intent-control";
import { ASK_LAYOUT, personasForAskPicker, primaryPersonaId, shouldSeedAskDraft } from "../lib/ask-dialog";
import type { Persona } from "../lib/api-client";

function persona(id: string, name: string, reportsTo: string | null): Persona {
  return {
    id,
    name,
    role: name,
    systemPrompt: "",
    voiceNotes: "",
    boundaries: "",
    scopeDescription: "",
    modelProvider: "anthropic",
    modelName: "claude-sonnet-5",
    assignedToolIds: [],
    status: "idle",
    lastSummary: "",
    reportsTo,
  };
}

describe("explicit notification intent control", () => {
  beforeEach(() => vi.stubGlobal("React", React));

  it("renders as an unchecked toggle when passed the per-turn default", () => {
    const control = NotificationIntentControl({ checked: false, onChange: vi.fn(), deviceCount: 0 });
    const toggle = control.props.children[0];
    expect(toggle.props.checked).toBe(false);
  });

  it("explains zero, one, and multiple enabled-device delivery", () => {
    expect(notificationDeviceHint(0)).toContain("No devices");
    expect(notificationDeviceHint(1)).toContain("1 enabled device.");
    expect(notificationDeviceHint(3)).toContain("3 enabled devices.");
  });
});

describe("Ask draft seeding", () => {
  it("seeds only when the dialog transitions from closed to open", () => {
    expect(shouldSeedAskDraft(true, false)).toBe(true);
    expect(shouldSeedAskDraft(true, true)).toBe(false);
    expect(shouldSeedAskDraft(false, true)).toBe(false);
    expect(shouldSeedAskDraft(false, false)).toBe(false);
  });

  it("does not reseed when the roster array identity changes while Ask is open", () => {
    // Regression: AppShell polls listPersonas every 15s and passes a new array
    // into DispatchDialog. Seeding on `personas` used to wipe the prompt and
    // jump the selected persona mid-sentence.
    const previouslyOpen = true;
    const open = true;
    expect(shouldSeedAskDraft(open, previouslyOpen)).toBe(false);
  });
});

describe("primary Ask persona", () => {
  it("returns null when the roster is empty", () => {
    expect(primaryPersonaId([])).toBeNull();
  });

  it("picks the top-of-chart persona, not personas[0] or a report", () => {
    const intern = persona("intern", "Intern", "finance");
    const finance = persona("finance", "Finance", "principal");
    const principal = persona("principal", "Assistant", null);
    expect(primaryPersonaId([intern, finance, principal])).toBe("principal");
  });

  it("treats an orphaned reportsTo as top-of-chart, matching the org chart", () => {
    const orphan = persona("orphan", "Orphan", "missing-manager");
    const report = persona("report", "Report", "orphan");
    expect(primaryPersonaId([report, orphan])).toBe("orphan");
  });

  it("prefers the root with the most direct reports when several trees exist", () => {
    const side = persona("side", "Side project", null);
    const principal = persona("principal", "Assistant", null);
    const report = persona("report", "Finance", "principal");
    expect(primaryPersonaId([side, report, principal])).toBe("principal");
  });

  it("puts the primary persona first in the picker, even if the roster is unordered", () => {
    const intern = persona("intern", "Intern", "principal");
    const principal = persona("principal", "Assistant", null);
    expect(personasForAskPicker([intern, principal]).map((p) => p.id)).toEqual(["principal", "intern"]);
  });
});

describe("Ask layout", () => {
  // The overlay/dialog chrome this used to assert on (full-screen mobile,
  // centered card from md up) is now the Sheet primitive's job -- see
  // sheet.test.tsx for that contract.
  it("has no bespoke overlay class strings left to keep in sync with Sheet", () => {
    expect(ASK_LAYOUT).not.toHaveProperty("overlay");
    expect(ASK_LAYOUT).not.toHaveProperty("dialog");
  });

  it("uses a dropdown on small screens instead of wrapping chips", () => {
    expect(ASK_LAYOUT.personaSelect).toContain("md:hidden");
    expect(ASK_LAYOUT.personaChips).toContain("hidden");
    expect(ASK_LAYOUT.personaChips).toContain("md:flex");
  });

  it("keeps the mobile persona select at 16px so iOS Safari does not zoom the visual viewport", () => {
    expect(ASK_LAYOUT.personaSelect).toContain("text-base");
    expect(ASK_LAYOUT.personaSelect).not.toMatch(/text-\[1[0-5]px\]/);
  });
});
