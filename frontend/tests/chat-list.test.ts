import { describe, expect, it } from "vitest";
import { sortedChatRows } from "../lib/chat-list.js";
import type { Job, Persona } from "../lib/api-client.js";

function job(id: string, personaId: string, updatedAt: string): Job {
  return {
    id,
    personaId,
    parentJobId: null,
    routineId: null,
    depth: 0,
    origin: "user",
    langgraphThreadId: `thread-${id}`,
    status: "done",
    prompt: `prompt for ${id}`,
    error: null,
    createdAt: updatedAt,
    updatedAt,
    retryEligible: false,
  };
}

function persona(id: string, name: string): Persona {
  return {
    id,
    name,
    role: "Assistant",
    systemPrompt: "",
    voiceNotes: "",
    boundaries: "",
    scopeDescription: "",
    modelProvider: "anthropic",
    modelName: "claude",
    assignedToolIds: [],
    status: "active",
    lastSummary: "",
    reportsTo: null,
  };
}

describe("sortedChatRows", () => {
  const wren = persona("wren", "Wren");

  it("orders every chat newest first regardless of persona", () => {
    const jobs = [
      job("older", "wren", "2026-08-24T12:00:00.000Z"),
      job("newest", "assistant", "2026-08-25T12:00:00.000Z"),
      job("middle", "wren", "2026-08-24T18:00:00.000Z"),
    ];
    const rows = sortedChatRows(jobs, [wren]);
    expect(rows.map((r) => r.job.id)).toEqual(["newest", "middle", "older"]);
  });

  it("resolves the owning persona, leaving it undefined when unknown", () => {
    const rows = sortedChatRows([job("a", "wren", "2026-08-24T12:00:00.000Z")], [wren]);
    expect(rows[0].persona).toBe(wren);

    const orphan = sortedChatRows([job("b", "ghost", "2026-08-24T12:00:00.000Z")], [wren]);
    expect(orphan[0].persona).toBeUndefined();
  });
});
