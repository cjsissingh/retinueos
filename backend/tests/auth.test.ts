import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { resetSettingsCache } from "../src/config.js";

describe("auth middleware", () => {
  beforeEach(() => {
    process.env.AUTH_PASSWORD = "test-password";
    resetSettingsCache();
  });

  it("rejects requests to protected routes without the header", async () => {
    const app = createApp();
    const res = await app.request("/personas");
    expect(res.status).toBe(401);
  });

  it("rejects the custom-tools routes without the header", async () => {
    const app = createApp();
    const bareRes = await app.request("/custom-tools");
    expect(bareRes.status).toBe(401);
    const nestedRes = await app.request("/custom-tools/some-key/versions");
    expect(nestedRes.status).toBe(401);
  });

  it("accepts requests with the correct header", async () => {
    const app = createApp();
    const res = await app.request("/personas", { headers: { "X-Auth-Password": "test-password" } });
    expect(res.status).toBe(200);
  });

  it("does not require auth for /health", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("rejects the SSE stream route (mounted at / per Task 12) without the header", async () => {
    // streamRoutes is mounted at "/" in app.ts, so `GET /jobs/:id/stream`
    // doesn't share the `/jobs` mount prefix directly -- confirm it's still
    // covered by the `/jobs/*` middleware pattern rather than assuming it.
    const app = createApp();
    const res = await app.request("/jobs/some-fake-id/stream");
    expect(res.status).toBe(401);
  });

  it("passes auth on the SSE stream route with the correct header (gets past the 401)", async () => {
    const app = createApp();
    const res = await app.request("/jobs/00000000-0000-0000-0000-000000000000/stream", {
      headers: { "X-Auth-Password": "test-password" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("accepts requests with the correct password as a query param (EventSource can't set headers)", async () => {
    const app = createApp();
    const res = await app.request("/personas?password=test-password");
    expect(res.status).toBe(200);
  });

  it("rejects requests with an incorrect password query param", async () => {
    const app = createApp();
    const res = await app.request("/personas?password=wrong-password");
    expect(res.status).toBe(401);
  });

  it("rejects requests with no header and no password query param", async () => {
    const app = createApp();
    const res = await app.request("/personas?foo=bar");
    expect(res.status).toBe(401);
  });

  it("passes auth on the SSE stream route with the correct password query param", async () => {
    const app = createApp();
    const res = await app.request("/jobs/00000000-0000-0000-0000-000000000000/stream?password=test-password");
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("rejects a password that shares a long prefix with the correct one", async () => {
    // Guards against comparing passwords with `!==`, which short-circuits on
    // the first mismatched character and so is not constant-time -- a
    // regression here wouldn't fail functionally, only reopen the timing
    // side channel, but a wrong-but-close password must still be a 401.
    const app = createApp();
    const res = await app.request("/personas", {
      headers: { "X-Auth-Password": "test-passwore" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects the pending-approvals SSE stream without the header", async () => {
    const app = createApp();
    const res = await app.request("/pending_approvals/stream");
    expect(res.status).toBe(401);
  });

  it("passes auth on the pending-approvals SSE stream with the correct password query param", async () => {
    const app = createApp();
    const res = await app.request("/pending_approvals/stream?password=test-password");
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("rejects a provided password longer than the correct one", async () => {
    const app = createApp();
    const res = await app.request("/personas", {
      headers: { "X-Auth-Password": "test-password-and-then-some" },
    });
    expect(res.status).toBe(401);
  });

  it.each(["token", "access_token", "password"])(
    "rejects %s query credentials on the control MCP endpoint before bearer parsing",
    async (parameter) => {
      const app = createApp();
      const res = await app.request(`/mcp/control?${parameter}=leaked-secret`, {
        headers: { Authorization: "Bearer malformed" },
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "credentials are not accepted in query parameters" });
    },
  );

  it("does not accept the owner password in place of a control-client bearer token", async () => {
    const app = createApp();
    const res = await app.request("/mcp/control", {
      headers: { "X-Auth-Password": "test-password" },
    });

    expect(res.status).toBe(401);
  });
});
