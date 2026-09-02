import { describe, expect, it } from "vitest";
import { boundJson, redactAuditValue } from "../src/control/bounded-json.js";

describe("boundJson", () => {
  it("keeps JSON within the byte limit unchanged", () => {
    expect(boundJson({ status: "ok" }, 64)).toEqual({ status: "ok" });
  });

  it("replaces oversized JSON with a stable digest marker", () => {
    const result = boundJson({ prompt: "x".repeat(200) }, 32);
    expect(result).toMatchObject({ truncated: true, algorithm: "sha256" });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts credential-shaped keys recursively before bounding", () => {
    expect(redactAuditValue({ nested: { bearerToken: "secret", name: "Desktop client" } })).toEqual({
      nested: { bearerToken: "[REDACTED]", name: "Desktop client" },
    });
  });

  it("redacts API keys without redacting token telemetry", () => {
    expect(redactAuditValue({ APIKey: "secret", promptTokens: 42 })).toEqual({
      APIKey: "[REDACTED]",
      promptTokens: 42,
    });
  });

  it("preserves Date JSON serialization while redacting nested credentials", () => {
    const createdAt = new Date("2026-08-25T16:00:00.000Z");

    expect(boundJson({ createdAt, nested: { bearerToken: "secret" } }, 1024)).toEqual({
      createdAt: createdAt.toJSON(),
      nested: { bearerToken: "[REDACTED]" },
    });
  });
});
