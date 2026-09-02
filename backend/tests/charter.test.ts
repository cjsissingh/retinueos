import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt, DELEGATION_FOLD_INSTRUCTION } from "../src/graph/charter.js";
import { buildPersonaGraph, type PersonaLike } from "../src/graph/persona-graph.js";
import { defaultRegistry } from "../src/tools/registry.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

describe("buildSystemPrompt", () => {
  it("returns just the system prompt plus the standing voice-boundary instruction when no charter fields are set", () => {
    const prompt = buildSystemPrompt({ systemPrompt: "You help with budgeting." });
    expect(prompt).toContain("You help with budgeting.");
    expect(prompt).toContain("Voice boundary");
    expect(prompt).not.toContain("Scope:");
    expect(prompt).not.toContain("Voice:");
    expect(prompt).not.toContain("Boundaries");
  });

  it("includes scope, voice, and boundaries sections when set", () => {
    const prompt = buildSystemPrompt({
      systemPrompt: "You advise on budgeting.",
      scopeDescription: "Household budgeting only.",
      voiceNotes: "Dry, understated.",
      boundaries: "Never gives personalized investment advice.",
    });
    expect(prompt).toContain("Scope: Household budgeting only.");
    expect(prompt).toContain("Voice: Dry, understated.");
    expect(prompt).toContain("Never gives personalized investment advice.");
  });
});

describe("delegation folding instruction", () => {
  it("is included in the assembled system prompt for a persona holding delegate_to", async () => {
    let capturedSystem: string | undefined;
    vi.mocked(generateText).mockImplementationOnce(async (opts: any) => {
      capturedSystem = opts.system;
      return { text: "ok", toolCalls: [] } as any;
    });

    const persona: PersonaLike = {
      modelProvider: "anthropic",
      modelName: "m",
      systemPrompt: "You are the Principal.",
      assignedToolIds: [{ toolId: "delegate_to" }],
    };
    const graph = buildPersonaGraph(persona, defaultRegistry);
    await graph.invoke(
      { messages: [{ role: "user", content: "hi" }] },
      { configurable: { thread_id: "charter-test-1" } },
    );

    expect(capturedSystem).toContain(DELEGATION_FOLD_INSTRUCTION);
  });

  it("is omitted for a persona with no delegate_to tool", async () => {
    let capturedSystem: string | undefined;
    vi.mocked(generateText).mockImplementationOnce(async (opts: any) => {
      capturedSystem = opts.system;
      return { text: "ok", toolCalls: [] } as any;
    });

    const persona: PersonaLike = {
      modelProvider: "anthropic",
      modelName: "m",
      systemPrompt: "You are Finance.",
      assignedToolIds: [],
    };
    const graph = buildPersonaGraph(persona, defaultRegistry);
    await graph.invoke(
      { messages: [{ role: "user", content: "hi" }] },
      { configurable: { thread_id: "charter-test-2" } },
    );

    expect(capturedSystem).not.toContain(DELEGATION_FOLD_INSTRUCTION);
  });
});
