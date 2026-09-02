import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { customToolRoutes } from "../src/tools/custom-tool-routes.js";

const { db } = useTestDb();

function buildApp(): Hono {
  const app = new Hono();
  app.route("/", customToolRoutes(db()));
  return app;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    toolKey: "weather-scraper",
    description: "Reads today's weather from a scraped page.",
    source: "export function run() { return { ok: true }; }",
    parametersSchema: { type: "object", properties: {} },
    hostAllowList: ["example.com"],
    secretRefs: [],
    limits: { timeoutMs: 5_000, memoryMb: 128, maxOutputBytes: 65_536 },
    suggestedRiskClass: "read_only",
    ...overrides,
  };
}

describe("POST /custom-tools", () => {
  it("creates version 1", async () => {
    const res = await buildApp().request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.toolKey).toBe("weather-scraper");
    expect(body.version).toBe(1);
  });

  it("rejects an invalid toolKey with 400", async () => {
    const res = await buildApp().request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "Not Valid!" })),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate toolKey with 409", async () => {
    const app = buildApp();
    await app.request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "dup-route" })),
    });
    const res = await app.request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "dup-route" })),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /custom-tools/:toolKey/versions", () => {
  it("creates version 2 for an existing toolKey", async () => {
    const app = buildApp();
    await app.request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "versioned-route" })),
    });
    const { toolKey: _toolKey, ...rest } = validBody({ toolKey: "versioned-route" });
    const res = await app.request("/custom-tools/versioned-route/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).version).toBe(2);
  });

  it("returns 404 for an unknown toolKey", async () => {
    const { toolKey: _toolKey, ...rest } = validBody();
    const res = await buildApp().request("/custom-tools/no-such-key/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rest),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /custom-tools and /custom-tools/:toolKey/versions", () => {
  it("lists tools and their version history", async () => {
    const app = buildApp();
    await app.request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "list-route" })),
    });
    const list = await (await app.request("/custom-tools")).json();
    expect(list.some((row: { toolKey: string }) => row.toolKey === "list-route")).toBe(true);
    const versions = await (await app.request("/custom-tools/list-route/versions")).json();
    expect(versions).toHaveLength(1);
  });

  it("returns 404 for version history of an unknown toolKey", async () => {
    const res = await buildApp().request("/custom-tools/nope/versions");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /custom-tools/:toolKey/versions/:version", () => {
  it("approves a pending version", async () => {
    const app = buildApp();
    await app.request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "approve-route" })),
    });
    const res = await app.request("/custom-tools/approve-route/versions/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("approved");
  });

  it("returns 409 for an already-decided version", async () => {
    const app = buildApp();
    await app.request("/custom-tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ toolKey: "twice-route" })),
    });
    await app.request("/custom-tools/twice-route/versions/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" }),
    });
    const res = await app.request("/custom-tools/twice-route/versions/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for an unknown version", async () => {
    const res = await buildApp().request("/custom-tools/nope/versions/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(404);
  });
});
