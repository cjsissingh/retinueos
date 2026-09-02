import type { ToolSpec } from "./registry.js";
import { z } from "zod";

const BRAVE_SEARCH_ORIGIN = "https://api.search.brave.com";

const freshnessSchema = z.string().regex(/^(day|week|month|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/);

const webSearchArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((query) => query.split(/\s+/).length <= 50, "Query must contain at most 50 words"),
  resultType: z.enum(["web", "news"]).optional().default("web"),
  count: z.number().int().min(1).max(20).optional().default(5),
  freshness: freshnessSchema.optional(),
});

const searchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  description: z.string().optional(),
  age: z.string().optional(),
});

const webResponseSchema = z.object({
  type: z.literal("search"),
  query: z.object({ original: z.string() }).nullable(),
  web: z.object({ results: z.array(searchResultSchema) }).nullable(),
});

const newsResponseSchema = z.object({
  type: z.literal("news"),
  query: z.object({ original: z.string() }),
  results: z.array(searchResultSchema),
});

function braveFreshness(value: string): string {
  if (value === "day") return "pd";
  if (value === "week") return "pw";
  if (value === "month") return "pm";
  return value;
}

interface NormalizedSearchResult {
  title: string;
  url: string;
  description: string;
  publishedAt?: string;
}

function normalizeResults(results: z.infer<typeof searchResultSchema>[]) {
  return results.map((result) => {
    const normalized: NormalizedSearchResult = {
      title: result.title,
      url: result.url,
      description: result.description ?? "",
    };
    if (result.age) normalized.publishedAt = result.age;
    return normalized;
  });
}

async function parseResponse(response: Response, resultType: "web" | "news", submittedQuery: string) {
  if (response.status === 429) throw new Error("Brave Search rate limit exceeded");
  if (response.status === 401 || response.status === 403) throw new Error("Brave Search rejected BRAVE_SEARCH_API_KEY");
  if (!response.ok) throw new Error(`Brave Search request failed (${response.status})`);

  let body: Record<string, unknown>;
  try {
    body = z.record(z.unknown()).parse(await response.json());
  } catch {
    throw new Error("Brave Search returned an invalid response");
  }

  if (resultType === "news") {
    const parsed = newsResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error("Brave Search returned an invalid response");
    return { query: parsed.data.query.original, results: normalizeResults(parsed.data.results) };
  }
  const parsed = webResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("Brave Search returned an invalid response");
  return {
    query: parsed.data.query?.original ?? submittedQuery,
    results: normalizeResults(parsed.data.web?.results ?? []),
  };
}

export function createWebSearchTool(apiKey: string, fetchSearch: typeof fetch = fetch): ToolSpec {
  return {
    id: "web_search",
    riskClass: "read_only",
    description:
      "Search the web or a dedicated news index for current information. Returns source titles, URLs, snippets, and publication times when available.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query, up to 400 characters." },
        resultType: {
          type: "string",
          enum: ["web", "news"],
          description: "Use news for a news digest or current-events research; defaults to web.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum results to return; defaults to 5 and is capped at 20 to keep agent context compact.",
        },
        freshness: {
          type: "string",
          pattern: "^(day|week|month|\\d{4}-\\d{2}-\\d{2}to\\d{4}-\\d{2}-\\d{2})$",
          description: "Optional age filter: day, week, month, or YYYY-MM-DDtoYYYY-MM-DD.",
        },
      },
      required: ["query"],
    },
    timeoutMs: 15_000,
    idempotent: true,
    run: async (rawArgs, ctx) => {
      const parsedArgs = webSearchArgsSchema.safeParse(rawArgs);
      if (!parsedArgs.success) {
        throw new Error(
          `Invalid web_search arguments: ${parsedArgs.error.issues.map((issue) => issue.message).join(", ")}`,
        );
      }
      const { query, resultType, count, freshness } = parsedArgs.data;
      const path = resultType === "news" ? "/res/v1/news/search" : "/res/v1/web/search";
      const url = new URL(path, BRAVE_SEARCH_ORIGIN);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      if (freshness) url.searchParams.set("freshness", braveFreshness(freshness));

      const response = await fetchSearch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
        signal: ctx?.signal,
      });
      const parsedResponse = await parseResponse(response, resultType, query);
      return { ...parsedResponse, resultType };
    },
  };
}
