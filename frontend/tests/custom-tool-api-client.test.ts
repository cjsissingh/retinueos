import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../lib/api-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Test fixture to stub fetch responses — the function accepts `unknown`
// because tests may pass any shape into the stub (that's the point of a stub).
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

const sampleProposal = {
  id: "1",
  toolKey: "weather-scraper",
  version: 1,
  description: "d",
  source: "s",
  parametersSchema: {},
  hostAllowList: [],
  secretRefs: [],
  limits: { timeoutMs: 1, memoryMb: 1, maxOutputBytes: 1 },
  suggestedRiskClass: "read_only",
  status: "pending",
  reviewNote: null,
  reviewedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("ApiClient custom-tool methods", () => {
  it("createCustomTool posts to /custom-tools", async () => {
    stubFetch(sampleProposal, 201);
    const client = new ApiClient("http://backend", () => "pw");
    const result = await client.createCustomTool({
      toolKey: "weather-scraper",
      description: "d",
      source: "s",
      parametersSchema: {},
      hostAllowList: [],
      secretRefs: [],
      limits: { timeoutMs: 1, memoryMb: 1, maxOutputBytes: 1 },
      suggestedRiskClass: "read_only",
    });
    expect(result.toolKey).toBe("weather-scraper");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://backend/custom-tools");
    expect(init?.method).toBe("POST");
  });

  it("listCustomTools gets /custom-tools", async () => {
    stubFetch([sampleProposal]);
    const client = new ApiClient("http://backend", () => "pw");
    const result = await client.listCustomTools();
    expect(result).toHaveLength(1);
  });

  it("listCustomToolVersions gets /custom-tools/:toolKey/versions", async () => {
    stubFetch([sampleProposal]);
    const client = new ApiClient("http://backend", () => "pw");
    await client.listCustomToolVersions("weather-scraper");
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://backend/custom-tools/weather-scraper/versions");
  });

  it("reviewCustomToolVersion patches /custom-tools/:toolKey/versions/:version", async () => {
    stubFetch({ ...sampleProposal, status: "approved" });
    const client = new ApiClient("http://backend", () => "pw");
    const result = await client.reviewCustomToolVersion("weather-scraper", 1, { status: "approved" });
    expect(result.status).toBe("approved");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://backend/custom-tools/weather-scraper/versions/1");
    expect(init?.method).toBe("PATCH");
  });
});
