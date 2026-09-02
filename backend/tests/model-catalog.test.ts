import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchAvailableModels, resetModelCatalogCache } from "../src/models/model-catalog.js";

// Test fixture standing in for a provider's JSON response body, deliberately
// varied per test case -- there's no one shape to name here.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchAvailableModels", () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    vi.unstubAllGlobals();
    resetModelCatalogCache();
  });

  it("returns [] for a provider with no API key configured, without calling fetch", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAvailableModels(["anthropic"]);

    expect(result).toEqual({ anthropic: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps Anthropic's own ordering (newest-first), not alphabetized", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: "claude-sonnet-5" }, { id: "claude-opus-4" }],
        }),
      ),
    );

    const result = await fetchAvailableModels(["anthropic"]);

    expect(result.anthropic).toEqual(["claude-sonnet-5", "claude-opus-4"]);
  });

  it("filters OpenAI's model list down to chat models, dropping tts/embedding/transcribe/etc.", async () => {
    process.env.OPENAI_API_KEY = "sk-x";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            { id: "gpt-5.6-sol" },
            { id: "gpt-5.6-luna" },
            { id: "gpt-4o-mini-tts" },
            { id: "whisper-1" },
            { id: "text-embedding-3-large" },
            { id: "dall-e-3" },
            { id: "o3-mini" },
          ],
        }),
      ),
    );

    const result = await fetchAvailableModels(["openai"]);

    expect(result.openai).toEqual(["gpt-5.6-luna", "gpt-5.6-sol", "o3-mini"]);
  });

  it("resolves to [] instead of throwing when a provider's fetch fails", async () => {
    process.env.OPENAI_API_KEY = "sk-x";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const result = await fetchAvailableModels(["openai"]);

    expect(result).toEqual({ openai: [] });
  });

  it("one provider failing doesn't take the other down with it", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    process.env.OPENAI_API_KEY = "sk-x";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("anthropic")) return Promise.resolve(new Response(null, { status: 500 }));
        return Promise.resolve(jsonResponse({ data: [{ id: "gpt-5.6-sol" }] }));
      }),
    );

    const result = await fetchAvailableModels(["anthropic", "openai"]);

    expect(result).toEqual({ anthropic: [], openai: ["gpt-5.6-sol"] });
  });

  it("caches a provider's result instead of re-fetching on every call", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: "claude-sonnet-5" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAvailableModels(["anthropic"]);
    await fetchAvailableModels(["anthropic"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
