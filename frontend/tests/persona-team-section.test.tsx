import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonaTeamSection } from "../components/persona-team-section.js";
import type { ApiClient, Persona } from "../lib/api-client.js";

function basePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    name: "Alex",
    role: "Ops",
    reportsTo: null,
    systemPrompt: "",
    scopeDescription: "",
    voiceNotes: "",
    boundaries: "",
    modelProvider: "anthropic",
    modelName: "claude",
    assignedToolIds: [],
    status: "idle",
    lastSummary: "",
    ...overrides,
  };
}

describe("team section", () => {
  it("shows the reports-to select and the direct-reports list together", () => {
    const alex = basePersona({ reportsTo: "p2" });
    const morgan = basePersona({ id: "p2", name: "Morgan", role: "Director" });
    const report = basePersona({ id: "p3", name: "Sam", reportsTo: "p1" });
    // SAFETY: this only SSR-renders the section's initial state -- no client
    // method is ever called.
    const client = {} as ApiClient;
    const markup = renderToStaticMarkup(
      <PersonaTeamSection
        client={client}
        persona={alex}
        managerCandidates={[morgan]}
        directReports={[report]}
        onSaved={() => {}}
      />,
    );

    expect(markup).toContain("<select");
    expect(markup).toContain("Morgan");
    expect(markup).toContain("Sam");
  });

  // Team is the *only* place a reports-to select renders -- the
  // generic Profile form that used to duplicate it is gone. A grep over the
  // other section forms' source is a cheaper, more direct guard against that
  // regression than trying to enumerate every place a <select> could sneak
  // back in via a render-based assertion.
  it("is the only section that renders a reports-to select", () => {
    const otherSections = [
      "../components/persona-identity-form.tsx",
      "../components/persona-charter-form.tsx",
      "../components/persona-tools-section.tsx",
      "../components/persona-side-panel.tsx",
    ];
    for (const path of otherSections) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).not.toContain("reportsTo");
    }
  });
});
