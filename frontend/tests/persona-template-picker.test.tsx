import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonaTemplatePicker } from "@/components/persona-template-picker";
import { ApiClient, type PersonaTemplate } from "@/lib/api-client";

const template: PersonaTemplate = {
  slug: "personal-assistant",
  name: "Alex",
  role: "Personal Assistant",
  systemPrompt: "Help the user stay on top of their day.",
  voiceNotes: "Warm and concise.",
  boundaries: "Never sends an email unreviewed.",
  scopeDescription: "Day-to-day admin: email drafts, reminders, and tracking commitments.",
  defaultTools: [{ toolId: "remember", permission: "allow" }],
};

const client = new ApiClient("http://example.test", () => null);

describe("PersonaTemplatePicker", () => {
  it("shows every template's name, role, and plain-language scope, plus from-scratch and AI options", () => {
    const markup = renderToStaticMarkup(
      <PersonaTemplatePicker client={client} templates={[template]} onChoose={() => {}} />,
    );

    expect(markup).toContain("Alex");
    expect(markup).toContain("Personal Assistant");
    expect(markup).toContain("Day-to-day admin");
    expect(markup).toContain("Start from scratch");
    expect(markup).toContain("Describe what you need");
    // Speaks in the operator's language: no raw tool id in the card body.
    expect(markup).not.toContain("remember");
  });

  it("every choice is a real button with a touch-sized target", () => {
    const markup = renderToStaticMarkup(
      <PersonaTemplatePicker client={client} templates={[template]} onChoose={() => {}} />,
    );
    const buttonOpenTags = [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttonOpenTags.length).toBeGreaterThanOrEqual(3); // template + describe + start from scratch
    for (const tag of buttonOpenTags) {
      expect(tag).toContain("min-h-11");
    }
  });

  it("renders nothing to choose from templates while still loading", () => {
    const onChoose = vi.fn();
    const markup = renderToStaticMarkup(
      <PersonaTemplatePicker client={client} templates={[]} onChoose={onChoose} loading />,
    );
    expect(markup).toContain("Loading starter templates");
  });
});
