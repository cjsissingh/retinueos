import { describe, expect, it } from "vitest";
import { resolveModel } from "../src/models/router.js";

describe("model router", () => {
  it("uses OpenAI Responses so reasoning models can call function tools", () => {
    expect(resolveModel("openai", "gpt-5.6-sol").provider).toBe("openai.responses");
  });
});
