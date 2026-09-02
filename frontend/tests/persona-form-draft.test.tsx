import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonaForm } from "@/components/persona-form";
import { ApiClient, type Persona } from "@/lib/api-client";

const savedPersona: Persona = {
  id: "persona-alex",
  name: "Alex",
  role: "Personal Assistant",
  systemPrompt: "Help the user stay on top of their day.",
  voiceNotes: "",
  boundaries: "",
  scopeDescription: "Day-to-day admin.",
  modelProvider: "anthropic",
  modelName: "claude-sonnet-5",
  assignedToolIds: [{ toolId: "remember", permission: "allow" }],
  status: "idle",
  lastSummary: "",
  reportsTo: null,
};

describe("PersonaForm draft prefill", () => {
  it("seeds name/role/charter/tools from a draft without switching into edit mode", () => {
    const client = new ApiClient("http://example.test", () => null);

    const markup = renderToStaticMarkup(
      <PersonaForm
        client={client}
        draft={{
          name: "Alex",
          role: "Personal Assistant",
          systemPrompt: "Help the user stay on top of their day.",
          scopeDescription: "Day-to-day admin.",
          assignedToolIds: [{ toolId: "remember", permission: "allow" }],
        }}
        onSave={() => Promise.resolve(savedPersona)}
        onSaved={() => {}}
        title="Hire a persona"
        submitLabel="Hire"
        submittingLabel="Hiring…"
        saveErrorLabel="hire them"
      />,
    );

    expect(markup).toContain('value="Alex"');
    expect(markup).toContain('value="Personal Assistant"');
    expect(markup).toContain("Help the user stay on top of their day.");
    // Still a hire form, not an edit form — no "Reports to" without candidates.
    expect(markup).not.toContain("Reports to");
    expect(markup).toContain("Hire</button>");
  });

  it("ignores the draft once an existing persona is passed as `initial`", () => {
    const client = new ApiClient("http://example.test", () => null);
    const persona: Persona = {
      id: "persona-wren",
      name: "Wren",
      role: "Researcher",
      systemPrompt: "Find the facts that matter.",
      voiceNotes: "",
      boundaries: "",
      scopeDescription: "",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-5",
      assignedToolIds: [],
      status: "idle",
      lastSummary: "",
      reportsTo: null,
    };

    const markup = renderToStaticMarkup(
      <PersonaForm
        client={client}
        initial={persona}
        draft={{ name: "Alex" }}
        onSave={() => Promise.resolve(persona)}
        onSaved={() => {}}
        title="Edit persona"
        submitLabel="Save changes"
        submittingLabel="Saving…"
        saveErrorLabel="save changes"
      />,
    );

    expect(markup).toContain('value="Wren"');
    expect(markup).not.toContain('value="Alex"');
  });
});
