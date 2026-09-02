import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersonaWorkspaceNav } from "@/components/persona-workspace-nav";

const NO_COUNTS = { tools: 0, team: 0, routines: 0, memory: 0 };

describe("PersonaWorkspaceNav", () => {
  it("gives each management concern a stable full-page destination -- no generic Profile", () => {
    const markup = renderToStaticMarkup(
      <PersonaWorkspaceNav personaId="persona-wren" active="tools" counts={NO_COUNTS} />,
    );

    expect(markup).toContain("Identity");
    expect(markup).toContain("Charter");
    expect(markup).toContain("Routines");
    expect(markup).toContain("Tools");
    expect(markup).toContain("Team");
    expect(markup).toContain("Memory");
    expect(markup).toContain("Usage");
    expect(markup).not.toContain(">Profile<");
    expect(markup).not.toContain(">Instructions<");
    expect(markup).toContain("/roster/persona-wren/manage?section=tools");
    expect(markup).toContain('aria-current="page"');
  });

  it("shows item counts next to the sections backed by a list", () => {
    const markup = renderToStaticMarkup(
      <PersonaWorkspaceNav
        personaId="persona-wren"
        active="tools"
        counts={{ tools: 9, team: 2, routines: 3, memory: 14 }}
      />,
    );

    expect(markup).toContain("9");
    expect(markup).toContain("2");
    expect(markup).toContain("3");
    expect(markup).toContain("14");
  });

  it("keeps chat as a clear peer destination instead of a dismiss action", () => {
    const markup = renderToStaticMarkup(
      <PersonaWorkspaceNav personaId="persona-wren" active="identity" counts={NO_COUNTS} />,
    );

    expect(markup).toContain("/roster/persona-wren");
    expect(markup).toContain("Back to chat");
  });
});
