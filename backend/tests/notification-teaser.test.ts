import { describe, expect, it } from "vitest";
import { toTeaser } from "../src/notifications/notify.js";

describe("notification teaser Unicode handling", () => {
  it("never splits an emoji at the truncation boundary", () => {
    const message = `${"x".repeat(198)}😀tail`;

    expect(toTeaser(message)).toBe(`${"x".repeat(198)}😀…`);
  });
});
