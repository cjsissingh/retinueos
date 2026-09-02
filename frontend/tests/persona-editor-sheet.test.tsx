import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonaEditorSheet } from "@/components/persona-editor-sheet";
import { ApiClient, type Persona } from "@/lib/api-client";

const persona: Persona = {
  id: "persona-wren",
  name: "Wren",
  role: "Researcher",
  systemPrompt: "Find the facts that matter.",
  voiceNotes: "Clear and concise.",
  boundaries: "Never invent sources.",
  scopeDescription: "Research and synthesis.",
  modelProvider: "anthropic",
  modelName: "claude-sonnet-5",
  assignedToolIds: [{ toolId: "get_weather" }],
  status: "idle",
  lastSummary: "",
  reportsTo: "persona-morgan",
};

const manager: Persona = {
  id: "persona-morgan",
  name: "Morgan",
  role: "Chief of Staff",
  systemPrompt: "Coordinate the team.",
  voiceNotes: "Direct and thoughtful.",
  boundaries: "Escalate consequential decisions.",
  scopeDescription: "Team coordination.",
  modelProvider: "anthropic",
  modelName: "claude-opus-5",
  assignedToolIds: [],
  status: "idle",
  lastSummary: "",
  reportsTo: null,
};

function buttonOpeningTag(markup: string, label: string): string {
  const labelIndex = markup.indexOf(label);
  const buttonStart = markup.lastIndexOf("<button", labelIndex);
  const buttonEnd = markup.indexOf(">", buttonStart);
  return markup.slice(buttonStart, buttonEnd + 1);
}

describe("PersonaEditorSheet", () => {
  it("renders every persona field group in the shared sheet without nested form chrome", () => {
    const client = new ApiClient("http://example.test", () => null);

    const markup = renderToStaticMarkup(
      <PersonaEditorSheet
        open
        onClose={() => {}}
        client={client}
        persona={persona}
        managerCandidates={[manager]}
        onSaved={() => {}}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Edit persona"');
    expect(markup).toContain('value="Wren"');
    expect(markup).toContain('value="claude-sonnet-5"');
    expect(markup).toContain("Reports to — the org chart");
    expect(markup).toContain("Morgan");
    expect(markup).toContain("Tool permissions");
    expect(markup.match(/<form[^>]*class="([^"]*)"/)?.[1]).toBe("flex flex-col gap-3");
    expect(buttonOpeningTag(markup, "Charter")).toContain("min-h-11");
    expect(buttonOpeningTag(markup, "Save changes")).toContain("min-h-11");
    expect(buttonOpeningTag(markup, "Cancel")).toContain("min-h-11");
  });

  it("renders the populated charter as an accessible disclosure with named fields", () => {
    const client = new ApiClient("http://example.test", () => null);

    const markup = renderToStaticMarkup(
      <PersonaEditorSheet
        open
        onClose={() => {}}
        client={client}
        persona={persona}
        managerCandidates={[manager]}
        onSaved={() => {}}
      />,
    );

    const disclosure = buttonOpeningTag(markup, "Charter");
    expect(disclosure).toContain('aria-expanded="true"');
    expect(disclosure).toContain("aria-controls=");
    expect(markup).toContain('name="scopeDescription"');
    expect(markup).toContain('name="voiceNotes"');
    expect(markup).toContain('name="boundaries"');
    expect(markup).toContain(">Scope</span>");
    expect(markup).toContain(">Voice &amp; personality</span>");
    expect(markup).toContain(">Boundaries</span>");
  });
});
