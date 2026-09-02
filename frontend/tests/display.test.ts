import { describe, expect, it } from "vitest";
import { displayEnum, displayModelName, relativeTime, shortId } from "@/lib/display";
import { getToolRenderer } from "@/lib/tool-renderers";

describe("operator-facing display data", () => {
  it("strips transport identifiers and underscores from an external tool headline", () => {
    expect(getToolRenderer("mcp:server-id:search_gmail_messages").title).toBe("Search Gmail messages");
    expect(getToolRenderer("gmail.search_messages").title).toBe("Gmail search messages");
  });

  it("formats model slugs as secondary readable names", () => {
    expect(displayModelName("openai", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(displayModelName("anthropic", "claude-sonnet-4-5")).toBe("Claude Sonnet 4.5");
  });

  it("turns enum storage values into sentence-case labels", () => {
    expect(displayEnum("waiting_approval")).toBe("Waiting approval");
    expect(displayEnum("outcome-unknown")).toBe("Outcome unknown");
  });

  it("shortens opaque identifiers without changing short values", () => {
    expect(shortId("d73344cd-ed5d-4317-ae4d-e2976d0d526d")).toBe("d73344cd");
    expect(shortId("local")).toBe("local");
  });

  it("formats relative time against an explicit clock", () => {
    const now = new Date("2026-08-30T14:00:00.000Z");
    expect(relativeTime("2026-08-30T13:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-08-30T13:15:00.000Z", now)).toBe("45m ago");
    expect(relativeTime("2026-08-29T10:00:00.000Z", now)).toBe("Aug 29");
  });
});
