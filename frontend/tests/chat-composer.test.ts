import { describe, expect, it } from "vitest";
import { shouldSubmitChatComposer } from "../lib/chat-composer.js";

function keyEvent(overrides: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): Parameters<typeof shouldSubmitChatComposer>[0] {
  return {
    key: overrides.key ?? "Enter",
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: {
      isComposing: overrides.isComposing,
      keyCode: overrides.keyCode,
    },
  };
}

describe("shouldSubmitChatComposer", () => {
  it("submits on Return", () => {
    expect(shouldSubmitChatComposer(keyEvent({}))).toBe(true);
  });

  it("does not submit on Shift+Return so the textarea can insert a newline", () => {
    expect(shouldSubmitChatComposer(keyEvent({ shiftKey: true }))).toBe(false);
  });

  it("does not submit for other keys", () => {
    expect(shouldSubmitChatComposer(keyEvent({ key: "a" }))).toBe(false);
  });

  it("does not submit while an IME composition is in progress", () => {
    expect(shouldSubmitChatComposer(keyEvent({ isComposing: true }))).toBe(false);
    expect(shouldSubmitChatComposer(keyEvent({ keyCode: 229 }))).toBe(false);
  });
});
