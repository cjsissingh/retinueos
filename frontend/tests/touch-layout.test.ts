import { describe, expect, it } from "vitest";
import {
  CONTENT_NARROW,
  CONTENT_WIDE,
  FILTER_CHIP,
  FILTER_ROW,
  LIST_ROW,
  PAGE_PAD,
  PRIMARY_BUTTON,
  SHELL_LAYOUT,
  SECTION_HEADING,
  TOUCH_TARGET,
  TWO_LINE_ROW,
} from "../lib/touch-layout.js";

describe("touch layout contract", () => {
  it("sizes nav, buttons, and list rows for thumbs (~44px)", () => {
    expect(TOUCH_TARGET).toContain("min-h-11");
    expect(PRIMARY_BUTTON).toContain("min-h-11");
    expect(FILTER_CHIP).toContain("min-h-11");
    expect(LIST_ROW).toContain("min-h-11");
    expect(SHELL_LAYOUT.mobileNavItem).toContain("min-h-11");
    expect(SHELL_LAYOUT.desktopNavItem).toContain("min-h-11");
    expect(SHELL_LAYOUT.desktopAsk).toContain("min-h-11");
  });

  it("keeps the mobile bottom bar above the home indicator and pads the main column for it", () => {
    expect(SHELL_LAYOUT.mobileNav).toContain("pb-[env(safe-area-inset-bottom,0px)]");
    expect(SHELL_LAYOUT.mobileNav).toContain("md:hidden");
    expect(SHELL_LAYOUT.main).toContain("env(safe-area-inset-bottom,0px)");
    expect(SHELL_LAYOUT.main).toContain("md:pb-0");
  });

  it("uses tighter page padding on a narrow viewport", () => {
    expect(PAGE_PAD).toContain("px-4");
    expect(PAGE_PAD).toContain("sm:px-8");
  });

  it("provides deliberate widths and section hierarchy for route layouts", () => {
    expect(CONTENT_NARROW).toContain("max-w-");
    expect(CONTENT_WIDE).toContain("max-w-content");
    expect(SECTION_HEADING).toContain("uppercase");
  });

  it("floats Ask above the bar, clear of the home indicator, not inside it", () => {
    expect(SHELL_LAYOUT.mobileAsk).toContain("fixed");
    expect(SHELL_LAYOUT.mobileAsk).toContain("min-h-11");
    expect(SHELL_LAYOUT.mobileAsk).toContain("env(safe-area-inset-bottom,0px)");
    expect(SHELL_LAYOUT.mobileAsk).toContain("md:hidden");
  });

  it("sizes More sheet rows to the same 44px target as every other list row", () => {
    expect(SHELL_LAYOUT.moreRow).toContain("min-h-11");
  });
});

describe("filters scroll instead of wrapping into a chip grid", () => {
  it("scrolls the filter row horizontally rather than wrapping", () => {
    expect(FILTER_ROW).toContain("overflow-x-auto");
    expect(FILTER_ROW).not.toContain("flex-wrap");
  });

  it("keeps chips from shrinking or wrapping inside that scroller", () => {
    expect(FILTER_CHIP).toContain("flex-none");
    expect(FILTER_CHIP).toContain("whitespace-nowrap");
  });
});

describe("data rows collapse to two lines below md", () => {
  it("stacks the primary and meta line, hidden at md and up where the grid takes over", () => {
    expect(TWO_LINE_ROW).toContain("flex-col");
    expect(TWO_LINE_ROW).toContain("md:hidden");
    expect(TWO_LINE_ROW).toContain("min-h-11");
  });
});
