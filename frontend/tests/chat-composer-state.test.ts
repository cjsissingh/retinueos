import { describe, expect, it } from "vitest";
import { composerState } from "../lib/chat-composer-state.js";

describe("composerState", () => {
  it("disables the composer while offline with a queued-when-you're-back hint, above any other reason", () => {
    expect(
      composerState({ online: false, sending: false, personaName: "Wren", activeJobStatus: "waiting_approval" }),
    ).toEqual({ disabled: true, hint: "Offline — queued when you're back." });
  });

  it("falls through to the ordinary job-status hint once back online, distinct from the offline one", () => {
    expect(composerState({ online: true, sending: false, personaName: "Wren", activeJobStatus: "running" })).toEqual({
      disabled: true,
      hint: "Wren is still working on the last message.",
    });
  });

  it("is enabled online with no active job", () => {
    expect(composerState({ online: true, sending: false, personaName: "Wren", activeJobStatus: undefined })).toEqual({
      disabled: false,
      hint: null,
    });
  });
});
