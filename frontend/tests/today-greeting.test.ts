import { describe, expect, it } from "vitest";
import { greetingStateLine, greetingWord } from "../lib/today-greeting.js";

describe("greetingWord", () => {
  it("picks the time-of-day greeting from an injected clock", () => {
    expect(greetingWord(new Date("2026-08-28T08:00:00"))).toBe("Good morning");
    expect(greetingWord(new Date("2026-08-28T14:00:00"))).toBe("Good afternoon");
    expect(greetingWord(new Date("2026-08-28T20:00:00"))).toBe("Good evening");
    expect(greetingWord(new Date("2026-08-28T02:00:00"))).toBe("Good evening");
  });
});

describe("greetingStateLine", () => {
  it("uses the fixed empty-day copy when nothing needs you, is running, or happened today", () => {
    expect(greetingStateLine({ needsYou: 0, working: 0, failedToday: 0, doneToday: 0 })).toBe(
      "Nobody's waiting on you.",
    );
  });

  it("composes the worked example from design guide", () => {
    expect(greetingStateLine({ needsYou: 3, working: 2, failedToday: 0, doneToday: 5 })).toBe(
      "Three things need you. Two people are working. Nothing failed overnight.",
    );
  });

  it("singularizes a count of one", () => {
    expect(greetingStateLine({ needsYou: 1, working: 1, failedToday: 1, doneToday: 1 })).toBe(
      "One thing needs you. One person is working. One thing failed overnight.",
    );
  });

  it("omits clauses with a zero count other than the always-present failure line", () => {
    expect(greetingStateLine({ needsYou: 0, working: 0, failedToday: 0, doneToday: 3 })).toBe(
      "Nothing failed overnight.",
    );
  });

  it("never uses an exclamation mark or emoji", () => {
    const line = greetingStateLine({ needsYou: 12, working: 4, failedToday: 2, doneToday: 20 });
    expect(line).not.toMatch(/!/);
    expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
