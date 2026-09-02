import { describe, expect, it } from "vitest";
import { SHEET_LAYOUT, isDismissKey, nextTrapIndex, sheetPanelClass, shouldDismissSwipe } from "../lib/sheet.js";

describe("swipe-to-dismiss threshold", () => {
  it("never dismisses on an upward or zero-height drag", () => {
    expect(shouldDismissSwipe(-40, 400)).toBe(false);
    expect(shouldDismissSwipe(0, 400)).toBe(false);
    expect(shouldDismissSwipe(200, 0)).toBe(false);
  });

  it("snaps back below the threshold, dismisses at or past it", () => {
    // 400 * 0.3 = 120px for a tall sheet.
    expect(shouldDismissSwipe(119, 400)).toBe(false);
    expect(shouldDismissSwipe(120, 400)).toBe(true);
    expect(shouldDismissSwipe(300, 400)).toBe(true);
  });

  it("floors the threshold so a short sheet still needs a deliberate drag", () => {
    // 100 * 0.3 = 30px, below the 60px floor -- the floor wins.
    expect(shouldDismissSwipe(45, 100)).toBe(false);
    expect(shouldDismissSwipe(60, 100)).toBe(true);
  });
});

describe("Esc dismiss", () => {
  it("only Escape dismisses, not Enter/Tab/other keys", () => {
    expect(isDismissKey("Escape")).toBe(true);
    expect(isDismissKey("Enter")).toBe(false);
    expect(isDismissKey("Tab")).toBe(false);
    expect(isDismissKey("a")).toBe(false);
  });
});

describe("focus trap wraparound", () => {
  it("wraps Tab from the last focusable back to the first", () => {
    expect(nextTrapIndex(2, 3, false)).toBe(0);
  });

  it("wraps Shift+Tab from the first focusable back to the last", () => {
    expect(nextTrapIndex(0, 3, true)).toBe(2);
  });

  it("enters at the first item when nothing in the trap has focus yet", () => {
    expect(nextTrapIndex(-1, 3, false)).toBe(0);
  });

  it("enters at the last item on a Shift+Tab from outside the trap", () => {
    expect(nextTrapIndex(-1, 3, true)).toBe(2);
  });

  it("is a no-op index when there is nothing focusable", () => {
    expect(nextTrapIndex(-1, 0, false)).toBe(-1);
  });
});

describe("Sheet layout contract", () => {
  it("is a full-bleed bottom sheet below md with the safe-area inset padded", () => {
    for (const panel of [SHEET_LAYOUT.panelRight, SHEET_LAYOUT.panelPopover]) {
      expect(panel).toContain("fixed inset-x-0 bottom-0");
      expect(panel).toContain("pb-[env(safe-area-inset-bottom,0px)]");
    }
  });

  it("becomes a fixed 460px right-hand panel at md for the 'right' anchor", () => {
    expect(sheetPanelClass("right")).toContain("md:w-[460px]");
    expect(sheetPanelClass("right")).toContain("md:right-0");
  });

  it("becomes a small anchored card at md for the 'popover' anchor, not a full-height panel", () => {
    const popover = sheetPanelClass("popover");
    expect(popover).toContain("md:absolute");
    expect(popover).toContain("md:w-[380px]");
    expect(popover).not.toContain("md:h-dvh");
  });

  it("keeps the drag handle mobile-only", () => {
    expect(SHEET_LAYOUT.dragArea).toContain("md:hidden");
  });

  it("gives the handle a 44px touch track around a thin visual bar", () => {
    expect(SHEET_LAYOUT.handleTrack).toContain("min-h-11");
    expect(SHEET_LAYOUT.handleBar).not.toContain("min-h-11");
  });
});
