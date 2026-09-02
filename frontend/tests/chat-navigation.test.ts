import { describe, expect, it } from "vitest";
import { delegatedChatHref, selectRequestedChat } from "../lib/chat-navigation.js";
import type { Job } from "../lib/api-client.js";

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
    prompt: null,
    error: null,
    createdAt: updatedAt,
    updatedAt,
    retryEligible: false,
  };
}

describe("delegated chat navigation", () => {
  const older = job("child-job", "research-lead-id", "2026-08-24T12:00:00.000Z");
  const newer = job("newest-job", "research-lead-id", "2026-08-25T12:00:00.000Z");

  it("builds a link to the delegate's exact chat", () => {
    expect(delegatedChatHref(older)).toBe("/roster/research-lead-id?chat=child-job");
  });

  it("selects a requested chat even when it is not the persona's newest", () => {
    expect(selectRequestedChat([older, newer], "child-job")).toBe("child-job");
  });

  it("does not select a chat that does not belong to the persona", () => {
    expect(selectRequestedChat([older, newer], "someone-elses-job")).toBe("newest-job");
  });

  it("keeps the new-chat composer selected when the URL requests it", () => {
    expect(selectRequestedChat([older, newer], "new")).toBeNull();
  });
});
