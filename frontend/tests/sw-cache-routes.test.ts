import { describe, expect, it } from "vitest";
import { isCacheableStaticAsset, isShellRoute, isStreamingRequest } from "../lib/sw-cache-routes.js";

describe("isShellRoute", () => {
  it("shells Today, the notification centre, and any chat page", () => {
    expect(isShellRoute("/today")).toBe(true);
    expect(isShellRoute("/notifications")).toBe(true);
    expect(isShellRoute("/roster/persona-1")).toBe(true);
    expect(isShellRoute("/roster/persona-1/")).toBe(true);
  });

  it("does not shell unrelated routes, including a bare /roster listing", () => {
    expect(isShellRoute("/approvals")).toBe(false);
    expect(isShellRoute("/roster")).toBe(false);
    expect(isShellRoute("/settings/access")).toBe(false);
    expect(isShellRoute("/login")).toBe(false);
  });
});

describe("isCacheableStaticAsset", () => {
  it("caches hashed Next chunks, icons, and the manifest", () => {
    expect(isCacheableStaticAsset("/_next/static/chunks/main.js")).toBe(true);
    expect(isCacheableStaticAsset("/icons/retinueos-192.png")).toBe(true);
    expect(isCacheableStaticAsset("/manifest.webmanifest")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isCacheableStaticAsset("/today")).toBe(false);
    expect(isCacheableStaticAsset("/api/jobs")).toBe(false);
  });
});

describe("isStreamingRequest", () => {
  it("never lets an SSE Accept header get intercepted and cached", () => {
    expect(isStreamingRequest("text/event-stream")).toBe(true);
    expect(isStreamingRequest("application/json, text/event-stream")).toBe(true);
  });

  it("treats an ordinary Accept header, or none, as cacheable", () => {
    expect(isStreamingRequest("application/json")).toBe(false);
    expect(isStreamingRequest(null)).toBe(false);
  });
});
