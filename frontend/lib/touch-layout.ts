/**
 * Shared mobile layout tokens for thumb-sized hit areas (~44px),
 * page padding that is not desktop-only, and the shell's bottom nav.
 * Keep class strings here so tests can lock the contract without mounting
 * the whole AppShell.
 */

/** 44px — Apple HIG / Material minimum touch target. Tailwind `11` = 2.75rem. */
export const TOUCH_TARGET = "min-h-11 min-w-11";

export const PAGE_PAD = "mx-auto max-w-content px-4 py-6 sm:px-8 sm:py-8";

export const CONTENT_NARROW = "mx-auto max-w-[760px]";
export const CONTENT_WIDE = "mx-auto max-w-content";
export const SECTION_HEADING = "font-mono text-[11px] font-medium uppercase tracking-wider text-fg-faint";

export const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-button border-0 px-3.5 font-sans text-[13px] font-medium";

export const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-button border px-3.5 font-sans text-[13px] font-medium";

// flex-none + whitespace-nowrap so a chip never shrinks or wraps inside
// FILTER_ROW's horizontal scroller -- a wrapped grid of chips is
// exactly what that scroller replaces.
export const FILTER_CHIP =
  "inline-flex min-h-11 flex-none items-center whitespace-nowrap rounded-full border px-3 font-sans text-[13px]";

// A row of filter chips (+ any trailing control, e.g. a persona <select>)
// that scrolls horizontally instead of wrapping onto a second/third line
// -- this is the one kind of horizontal scroll the no-overflow
// rule allows: it's a self-contained scroller, not the page itself getting
// wider than the viewport. `-mx-4`/`px-4` extends the scroll track to the
// page's own edges on mobile so a partially visible last chip reads as
// "more to scroll" rather than an odd clipped gap.
export const FILTER_ROW = "flex items-center gap-2 overflow-x-auto -mx-4 px-4 pb-1 sm:mx-0 sm:px-0";

export const LIST_ROW = "min-h-11";

// Below md, a data row (Logs/Audit/Usage) collapses from a
// multi-column grid to two lines: a primary line (what happened / who) and
// a meta line (status · time · numbers) instead of every column stacking
// on its own line, which is how the old flex-col fallback still ran past
// two lines and, for a `<code>` column with no wrap, past the viewport's
// width too.
export const TWO_LINE_ROW = "flex min-h-11 flex-col justify-center gap-1 py-2.5 md:hidden";
export const TWO_LINE_META =
  "flex flex-wrap items-center gap-x-1.5 gap-y-1 overflow-hidden font-mono text-[11px] text-fg-faint";

export const SHELL_LAYOUT = {
  mobileNav:
    "fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t pb-[env(safe-area-inset-bottom,0px)] md:hidden",
  mobileNavItem:
    "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center px-1 font-sans text-[10px] leading-tight no-underline",
  // Icon-only from md (768) to shell-lg (1180); icon + label from shell-lg
  // up (design doc §05's middle tier). desktopLabel is the label span that
  // only appears once there's room for it.
  desktopNavItem:
    "flex min-h-11 items-center justify-center gap-2.5 rounded-button px-3 py-2.5 font-sans text-sm no-underline shell-lg:justify-start",
  desktopAsk:
    "mb-3.5 flex min-h-11 items-center justify-center gap-2 rounded-button border-0 px-3 py-2.5 text-left font-sans text-[13px] font-medium shell-lg:justify-start",
  desktopSignOut:
    "flex min-h-11 items-center justify-center gap-2 rounded-button border-0 bg-transparent px-3 py-2 text-left font-sans text-[13px] text-fg-faint shell-lg:justify-start",
  desktopLabel: "hidden shell-lg:inline",
  // Floating above the tab bar, not one of its five items -- an
  // action, not a destination. Positioned clear of the bar plus the home
  // indicator safe area, right-anchored for one-handed reach.
  mobileAsk:
    "fixed right-4 bottom-[calc(2.75rem+env(safe-area-inset-bottom,0px)+0.75rem)] z-40 inline-flex min-h-11 items-center gap-1.5 rounded-full border-0 px-4 font-sans text-[13px] font-medium shadow-overlay md:hidden",
  // One row inside the More sheet -- same 44px target as every other list
  // row (LIST_ROW), full-width and left-aligned rather than the desktop
  // rail's icon-plus-label treatment.
  moreRow: "flex min-h-11 w-full items-center rounded-button px-3 text-left font-sans text-sm no-underline",
  main: "min-w-0 flex-1 pt-11 pb-[calc(2.75rem+env(safe-area-inset-bottom,0px))] md:ml-16 md:pt-0 md:pb-0 shell-lg:ml-[240px]",
} as const;
