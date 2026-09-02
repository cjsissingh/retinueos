import { describe, expect, it } from "vitest";
import { createWebSearchTool } from "../src/tools/web-search.js";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web_search", () => {
  it("maps a web query to Brave and returns compact source results", async () => {
    let request: Request | undefined;
    const fetchSearch: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return jsonResponse({
        type: "search",
        query: { original: "latest TypeScript release" },
        web: {
          results: [
            {
              title: "TypeScript 6.1 announced",
              url: "https://example.com/typescript-6-1",
              description: "The TypeScript team announced version 6.1.",
              age: "2026-08-28T12:00:00.000Z",
              language: "en",
              profile: { long_name: "Example" },
            },
          ],
        },
      });
    };
    const tool = createWebSearchTool("secret-key", fetchSearch);

    const result = await tool.run({ query: "latest TypeScript release", count: 3, freshness: "week" });

    expect(request?.url).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=latest+TypeScript+release&count=3&freshness=pw",
    );
    expect(request?.headers.get("x-subscription-token")).toBe("secret-key");
    expect(result).toEqual({
      query: "latest TypeScript release",
      resultType: "web",
      results: [
        {
          title: "TypeScript 6.1 announced",
          url: "https://example.com/typescript-6-1",
          description: "The TypeScript team announced version 6.1.",
          publishedAt: "2026-08-28T12:00:00.000Z",
        },
      ],
    });
  });

  it("uses Brave's news index and supports a custom date range", async () => {
    let requestUrl = "";
    const fetchSearch: typeof fetch = async (input) => {
      requestUrl = String(input);
      return jsonResponse({
        type: "news",
        query: { original: "space launch" },
        results: [
          {
            title: "Mission launches",
            url: "https://example.com/launch",
            description: "A new mission reached orbit.",
            age: "2 hours ago",
          },
        ],
      });
    };
    const tool = createWebSearchTool("secret-key", fetchSearch);

    const result = await tool.run({
      query: "space launch",
      resultType: "news",
      count: 10,
      freshness: "2026-08-01to2026-08-29",
    });

    expect(requestUrl).toBe(
      "https://api.search.brave.com/res/v1/news/search?q=space+launch&count=10&freshness=2026-08-01to2026-08-29",
    );
    expect(result.results).toEqual([
      {
        title: "Mission launches",
        url: "https://example.com/launch",
        description: "A new mission reached orbit.",
        publishedAt: "2 hours ago",
      },
    ]);
  });

  it("returns no results when Brave has no web result block", async () => {
    const fetchSearch: typeof fetch = async () => jsonResponse({ type: "search", query: null, web: null });
    const tool = createWebSearchTool("secret-key", fetchSearch);

    await expect(tool.run({ query: "unfindable subject" })).resolves.toEqual({
      query: "unfindable subject",
      resultType: "web",
      results: [],
    });
  });

  it("rejects queries over Brave's 50-word limit before making a request", async () => {
    let requested = false;
    const fetchSearch: typeof fetch = async () => {
      requested = true;
      return jsonResponse({ type: "search", query: { original: "test" }, web: { results: [] } });
    };
    const tool = createWebSearchTool("secret-key", fetchSearch);
    const query = Array.from({ length: 51 }, () => "word").join(" ");

    await expect(tool.run({ query })).rejects.toThrow("Query must contain at most 50 words");
    expect(requested).toBe(false);
  });

  it("passes the job cancellation signal to Brave", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchSearch: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal;
      return jsonResponse({ type: "search", query: { original: "test" }, web: { results: [] } });
    };
    const tool = createWebSearchTool("secret-key", fetchSearch);

    await tool.run(
      { query: "test" },
      {
        personaId: "persona-1",
        jobId: "job-1",
        toolCallId: "call-1",
        db: {},
        signal: controller.signal,
      },
    );

    expect(receivedSignal).toBe(controller.signal);
  });

  it("surfaces Brave rate limits without leaking the API key", async () => {
    const fetchSearch: typeof fetch = async () => jsonResponse({ error: { detail: "Rate limit exceeded" } }, 429);
    const tool = createWebSearchTool("super-secret-key", fetchSearch);

    await expect(tool.run({ query: "test" })).rejects.toThrow("Brave Search rate limit exceeded");
    await expect(tool.run({ query: "test" })).rejects.not.toThrow("super-secret-key");
  });

  it("rejects a malformed successful response", async () => {
    const fetchSearch: typeof fetch = async () => jsonResponse({ type: "search", web: { results: "invalid" } });
    const tool = createWebSearchTool("secret-key", fetchSearch);

    await expect(tool.run({ query: "test" })).rejects.toThrow("Brave Search returned an invalid response");
  });
});
