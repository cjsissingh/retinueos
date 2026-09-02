import { describe, it, expect } from "vitest";
import { chatTitle } from "../lib/chat-title.js";
import { PERSONA_CHAT_LAYOUT, keyboardAwarePageStyle } from "../lib/persona-chat-layout.js";
import type { Job } from "../lib/api-client.js";

function baseJob(overrides: Partial<Job>): Job {
  return {
    id: "j1",
    personaId: "p1",
    parentJobId: null,
    routineId: null,
    depth: 0,
    origin: "user",
    langgraphThreadId: "t1",
    status: "done",
    prompt: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    retryEligible: false,
    ...overrides,
  };
}

describe("chatTitle", () => {
  it("uses the opening prompt as the chat's sidebar label", () => {
    expect(chatTitle(baseJob({ prompt: "Chase Northbank on invoice 4471." }))).toBe("Chase Northbank on invoice 4471.");
  });

  it("trims a long prompt with an ellipsis instead of overflowing the sidebar row", () => {
    const long = "A".repeat(80);
    const title = chatTitle(baseJob({ prompt: long }));
    expect(title).toBe(`${"A".repeat(48)}…`);
    expect(title.length).toBeLessThan(long.length);
  });

  it("falls back to a generic label for rows that predate the prompt column", () => {
    expect(chatTitle(baseJob({ prompt: null }))).toBe("Chat");
  });
});

describe("persona chat layout", () => {
  it("stacks desktop rails and constrains transcript content on mobile", () => {
    // This catches restoring fixed desktop columns or removing the width
    // constraints that keep long transcript/tool content inside the viewport.
    expect(PERSONA_CHAT_LAYOUT.body).toContain("flex-col");
    expect(PERSONA_CHAT_LAYOUT.body).toContain("md:flex-row");
    expect(PERSONA_CHAT_LAYOUT.chatColumn).toContain("min-w-0");
    expect(PERSONA_CHAT_LAYOUT.transcript).toContain("max-w-full");
    expect(PERSONA_CHAT_LAYOUT.chatSidebar).toContain("md:w-[260px]");
  });

  it("gives the transcript the only column on a narrow viewport", () => {
    // Persona/job rails must not sit in the vertical stack on a phone —
    // they open from the header instead, as a Sheet below md
    // rather than an in-flow column (the chats sidebar is now
    // desktop-only, `hidden` below md with no bespoke mobile-open variant).
    expect(PERSONA_CHAT_LAYOUT.chatSidebar).toContain("hidden");
    expect(PERSONA_CHAT_LAYOUT.chatSidebar).toContain("md:flex");
    expect(PERSONA_CHAT_LAYOUT).not.toHaveProperty("rail");
    expect(PERSONA_CHAT_LAYOUT.page).toContain("100dvh");
    expect(PERSONA_CHAT_LAYOUT.page).not.toContain("max-h-48");
  });

  it("has no bespoke mobile-overlay class strings left to keep in sync with Sheet", () => {
    expect(PERSONA_CHAT_LAYOUT).not.toHaveProperty("chatSidebarMobileOpen");
    expect(PERSONA_CHAT_LAYOUT).not.toHaveProperty("chatSidebarMobileClosed");
    expect(PERSONA_CHAT_LAYOUT).not.toHaveProperty("sidePanel");
  });
});

describe("keyboardAwarePageStyle", () => {
  it("leaves the page's own dvh-based height in charge when the keyboard is closed", () => {
    expect(keyboardAwarePageStyle(0)).toBeUndefined();
  });

  it("shrinks the page by exactly the keyboard's occlusion when it's open", () => {
    expect(keyboardAwarePageStyle(300)).toEqual({
      height: "calc(100dvh - 2.75rem - env(safe-area-inset-bottom, 0px) - 300px)",
    });
  });
});
