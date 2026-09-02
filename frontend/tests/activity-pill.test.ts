import { describe, it, expect } from "vitest";
import { groupTimelineForPills, toolCallTranscriptEntry, type TimelineEntry } from "../lib/activity-pill.js";
import type { Message, ToolCall } from "../lib/api-client.js";

function baseToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "tc1",
    jobId: "j1",
    callId: null,
    toolId: "gmail.search",
    riskClass: "read_only",
    arguments: {},
    status: "executed",
    result: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function toolCallEntry(overrides: Partial<ToolCall>, at = "2026-01-01T00:00:00.000Z"): TimelineEntry {
  const toolCall = baseToolCall(overrides);
  return { kind: "tool_call", at, toolCall };
}

function messageEntry(id: string): TimelineEntry {
  const message: Message = {
    id,
    jobId: "j1",
    role: "assistant",
    content: "done",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { kind: "message", at: message.createdAt, message };
}

describe("groupTimelineForPills", () => {
  it("leaves a lone tool call ungrouped -- nothing to merge it with", () => {
    const entries = [toolCallEntry({ id: "tc1" })];
    const grouped = groupTimelineForPills(entries);
    expect(grouped).toEqual(entries);
  });

  it("merges a run of consecutive tool calls into one pill", () => {
    const entries = [
      toolCallEntry({ id: "tc1", toolId: "gmail.search" }),
      toolCallEntry({ id: "tc2", toolId: "gmail.search" }),
      toolCallEntry({ id: "tc3", toolId: "gmail.label" }),
    ];
    const grouped = groupTimelineForPills(entries);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ kind: "activity_pill", connector: "gmail", count: 3 });
    if (grouped[0].kind !== "activity_pill") throw new Error("expected a pill");
    expect(grouped[0].calls.map((tc) => tc.id)).toEqual(["tc1", "tc2", "tc3"]);
  });

  it("a message between two tool calls splits the run", () => {
    const entries = [toolCallEntry({ id: "tc1" }), messageEntry("m1"), toolCallEntry({ id: "tc2" })];
    const grouped = groupTimelineForPills(entries);
    expect(grouped.map((e) => e.kind)).toEqual(["tool_call", "message", "tool_call"]);
  });

  it("a failed call in the middle of a run splits it and stays uncollapsed", () => {
    const entries = [
      toolCallEntry({ id: "tc1" }),
      toolCallEntry({ id: "tc2" }),
      toolCallEntry({ id: "tc3", status: "failed" }),
      toolCallEntry({ id: "tc4" }),
      toolCallEntry({ id: "tc5" }),
    ];
    const grouped = groupTimelineForPills(entries);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ kind: "activity_pill", count: 2 });
    expect(grouped[1]).toMatchObject({ kind: "tool_call" });
    if (grouped[1].kind !== "tool_call") throw new Error("expected the failed call to stay a plain entry");
    expect(grouped[1].toolCall.status).toBe("failed");
    expect(grouped[2]).toMatchObject({ kind: "activity_pill", count: 2 });
  });

  it("counts repeated calls to the same tool in the summary", () => {
    const entries = [
      toolCallEntry({ id: "tc1", toolId: "gmail.search" }),
      toolCallEntry({ id: "tc2", toolId: "gmail.search" }),
      toolCallEntry({ id: "tc3", toolId: "gmail.label" }),
    ];
    const grouped = groupTimelineForPills(entries);
    if (grouped[0].kind !== "activity_pill") throw new Error("expected a pill");
    expect(grouped[0].summary).toBe("gmail search ×2, gmail label");
  });

  it("falls back to a generic connector when a run mixes connectors", () => {
    const entries = [
      toolCallEntry({ id: "tc1", toolId: "gmail.search" }),
      toolCallEntry({ id: "tc2", toolId: "calendar_create_event" }),
    ];
    const grouped = groupTimelineForPills(entries);
    if (grouped[0].kind !== "activity_pill") throw new Error("expected a pill");
    expect(grouped[0].connector).toBe("tools");
  });
});

describe("toolCallTranscriptEntry", () => {
  it("carries the tool call's arguments and result through unchanged", () => {
    const toolCall = baseToolCall({ id: "tc1", arguments: { to: "a@b.com" }, result: { ok: true } });
    const entry = toolCallTranscriptEntry(toolCall);
    expect(entry).toMatchObject({
      key: "tc1",
      kind: "tool_result",
      data: { toolId: "gmail.search", arguments: { to: "a@b.com" }, result: { ok: true } },
    });
  });
});
