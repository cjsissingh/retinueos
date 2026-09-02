import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import { getSettings } from "../src/config.js";

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("CORS", () => {
  it("answers an OPTIONS preflight to a protected route with Access-Control-Allow-Origin", async () => {
    const app = createApp();
    const origin = getSettings().frontendOrigin;
    const res = await app.request("/personas", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-Auth-Password",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });
});
