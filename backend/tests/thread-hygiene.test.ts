import { describe, it, expect } from "vitest";
import type { ChatMessage } from "../src/graph/chat-message.js";
import { recentContextStart } from "../src/graph/thread-hygiene.js";

describe("recentContextStart", () => {
  it("keeps every recent user turn that jointly still fits the recent-context budget, not just the newest one", () => {
    // Regression test: recentContextStart walks backward from the newest
    // user turn looking for the earliest turn boundary whose slice-to-end
    // still fits RECENT_CONTEXT_TOKEN_BUDGET. Because `messages.slice(index)`
    // only grows as `index` decreases, the check at the very first (newest)
    // index trivially passes — a buggy implementation that returns on the
    // first passing check therefore always returns the newest user turn and
    // never explores further back, discarding recent history the budget was
    // meant to preserve. This conversation has two small recent turns that
    // easily fit together; both must be kept.
    const messages: ChatMessage[] = [
      { role: "user", content: `OLDEST ${"x".repeat(50_000)}` },
      { role: "assistant", content: "Old reply." },
      { role: "user", content: "MID small question." },
      { role: "assistant", content: "MID small reply." },
      { role: "user", content: "NEWEST small question." },
    ];

    const start = recentContextStart(messages);

    // The oldest (huge) turn must be excluded from the recent window on its
    // own — otherwise this test wouldn't distinguish "extends the window"
    // from "keeps everything".
    expect(start).toBeGreaterThan(0);
    const recent = messages.slice(start);
    const serialized = JSON.stringify(recent);
    expect(serialized).toContain("MID small question");
    expect(serialized).toContain("NEWEST small question");
    expect(serialized).not.toContain("OLDEST");
  });

  it("returns just the newest user turn when even that alone exceeds the recent-context budget", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: `OLD ${"x".repeat(50_000)}` },
      { role: "assistant", content: "Old reply." },
      { role: "user", content: `NEWEST ${"y".repeat(50_000)}` },
    ];

    const start = recentContextStart(messages);

    expect(start).toBe(2);
  });
});
