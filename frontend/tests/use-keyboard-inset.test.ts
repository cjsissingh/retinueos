import { describe, expect, it } from "vitest";
import { computeKeyboardInset } from "../lib/use-keyboard-inset.js";

describe("computeKeyboardInset", () => {
  it("reports no occlusion when the visual viewport matches the layout viewport", () => {
    expect(computeKeyboardInset(844, 844, 0)).toBe(0);
  });

  it("reports the keyboard's height once it clears the jitter threshold", () => {
    // 844 layout, 500 visible -- a real iOS keyboard-open shape.
    expect(computeKeyboardInset(844, 500, 0)).toBe(344);
  });

  it("ignores a small gap below the threshold (chrome bounce, rounding)", () => {
    // 844 - 800 = 44px, below the 80px floor.
    expect(computeKeyboardInset(844, 800, 0)).toBe(0);
  });

  it("nets out how far the page auto-scrolled to keep the focused field visible", () => {
    // iOS scrolled the page 20px to reveal the composer above the keyboard --
    // that 20px isn't itself keyboard occlusion.
    expect(computeKeyboardInset(844, 600, 20)).toBe(224);
  });

  it("floors at zero rather than going negative on an inverted reading", () => {
    expect(computeKeyboardInset(700, 844, 0)).toBe(0);
  });
});
