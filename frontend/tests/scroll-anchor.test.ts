import { describe, expect, it } from "vitest";
import { bottomScrollTop, isNearBottom } from "../lib/scroll-anchor.js";

describe("isNearBottom", () => {
  it("is true exactly at the bottom", () => {
    expect(isNearBottom(500, 600, 100)).toBe(true);
  });

  it("stays true within the near-bottom threshold", () => {
    // 600 - 100 - 452 = 48px short of the bottom -- right at the floor.
    expect(isNearBottom(452, 600, 100)).toBe(true);
  });

  it("is false once scrolled up past the threshold", () => {
    expect(isNearBottom(400, 600, 100)).toBe(false);
  });

  it("is true when the content doesn't overflow the viewport at all", () => {
    expect(isNearBottom(0, 80, 200)).toBe(true);
  });
});

describe("bottomScrollTop", () => {
  it("is the scroll position that reveals the last pixel of content", () => {
    expect(bottomScrollTop(600, 100)).toBe(500);
  });

  it("never goes negative when content is shorter than the viewport", () => {
    expect(bottomScrollTop(80, 200)).toBe(0);
  });
});
