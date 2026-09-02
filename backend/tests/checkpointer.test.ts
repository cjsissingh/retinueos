import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeCheckpointer } from "../src/graph/checkpointer.js";
import { buildPersonaGraph, type PersonaLike } from "../src/graph/persona-graph.js";
import { defaultRegistry } from "../src/tools/registry.js";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const fakePersona: PersonaLike = {
  modelProvider: "anthropic",
  modelName: "claude-sonnet-5",
  systemPrompt: "You are a helpful assistant.",
  assignedToolIds: [],
};

describe("Postgres checkpointer", () => {
  let checkpointer: PostgresSaver;

  beforeEach(async () => {
    checkpointer = makeCheckpointer(process.env.DATABASE_URL!);
    await checkpointer.setup();
  });

  afterEach(async () => {
    await checkpointer.end?.();
  });

  it("persists thread state across invocations", async () => {
    const graph = buildPersonaGraph(fakePersona, defaultRegistry, checkpointer);
    // Unique per run, not a fixed literal: against a Postgres that persists
    // across `vitest run` invocations (the LOCAL_TEST_DATABASE_URL escape
    // hatch in tests/setup/global-setup.ts), a fixed thread_id would carry
    // over checkpointed state from a prior run of this same test.
    const config = { configurable: { thread_id: randomUUID() } };

    vi.mocked(generateText).mockResolvedValueOnce({ text: "first", toolCalls: [] } as any);
    await graph.invoke({ messages: [{ role: "user", content: "hello" }] }, config);

    vi.mocked(generateText).mockResolvedValueOnce({ text: "second", toolCalls: [] } as any);
    const result = await graph.invoke({ messages: [{ role: "user", content: "again" }] }, config);

    const rolesAndContent = result.messages.map((m) => [m.role, m.content]);
    expect(rolesAndContent).toContainEqual(["user", "hello"]);
    expect(rolesAndContent).toContainEqual(["assistant", "first"]);
    expect(rolesAndContent).toContainEqual(["user", "again"]);
    expect(rolesAndContent).toContainEqual(["assistant", "second"]);
  });
});
