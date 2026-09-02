import { describe, it, expect } from "vitest";
import { STARTER_PERSONA_TEMPLATES, availableStarterTemplates } from "../src/personas/persona-templates.js";
import { PersonaCreateSchema } from "../src/personas/persona-schemas.js";
import { ToolRegistry } from "../src/tools/registry.js";
import "../src/tools/builtin.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { RoutineService } from "../src/control/routine-service.js";

function registryWithBuiltins() {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, { routineService: {} as RoutineService, webSearchApiKey: "test-key" });
  return registry;
}

describe("STARTER_PERSONA_TEMPLATES", () => {
  it("has between 3 and 6 templates", () => {
    expect(STARTER_PERSONA_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(STARTER_PERSONA_TEMPLATES.length).toBeLessThanOrEqual(6);
  });

  it("has a unique slug per template", () => {
    const slugs = STARTER_PERSONA_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("each template's fields satisfy PersonaCreateSchema once model fields are added", () => {
    for (const template of STARTER_PERSONA_TEMPLATES) {
      const result = PersonaCreateSchema.safeParse({
        name: template.name,
        role: template.role,
        systemPrompt: template.systemPrompt,
        voiceNotes: template.voiceNotes,
        boundaries: template.boundaries,
        scopeDescription: template.scopeDescription,
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        assignedToolIds: template.defaultTools,
      });
      expect(result.success, JSON.stringify(result.success ? undefined : result.error.flatten())).toBe(true);
    }
  });

  it("every default tool id is a real, currently-registered tool", () => {
    const registry = registryWithBuiltins();
    for (const template of STARTER_PERSONA_TEMPLATES) {
      for (const { toolId } of template.defaultTools) {
        expect(registry.has(toolId), `${template.slug} references unknown tool ${toolId}`).toBe(true);
      }
    }
  });
});

describe("availableStarterTemplates", () => {
  it("drops default tools that aren't registered on this deployment", () => {
    const registry = new ToolRegistry(); // nothing registered
    const templates = availableStarterTemplates(registry);
    expect(templates.length).toBe(STARTER_PERSONA_TEMPLATES.length);
    for (const template of templates) {
      expect(template.defaultTools).toEqual([]);
    }
  });

  it("keeps default tools that are registered", () => {
    const registry = registryWithBuiltins();
    const templates = availableStarterTemplates(registry);
    const withTools = templates.find((t) => t.defaultTools.length > 0);
    expect(withTools).toBeDefined();
  });
});
