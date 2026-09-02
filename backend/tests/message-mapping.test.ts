import { describe, expect, it } from "vitest";
import { toModelMessages } from "../src/graph/message-mapping.js";

describe("toModelMessages", () => {
  it("omits an orphaned historical tool call before a later user message", () => {
    const messages = toModelMessages([
      { role: "user", content: "Ask the research lead for a summary." },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_TiTepvxgDC9r9ceQfGhIqbMN",
            name: "delegate_to",
            arguments: { personaId: "research-lead", task: "Summarize the quarterly report." },
          },
        ],
      },
      { role: "user", content: "Let's try that again." },
    ]);

    expect(messages).toEqual([
      { role: "user", content: "Ask the research lead for a summary." },
      { role: "user", content: "Let's try that again." },
    ]);
  });
});
