/**
 * Pure decision logic + layout contract for the Sheet primitive --
 * the one overlay component every drawer/panel/dialog in the app uses (the
 * More menu, the persona side panel, the chat switcher, the dispatch
 * dialog, filters, the notification centre). Kept separate from
 * components/ui/sheet.tsx so the dismiss/swipe/focus-trap math can be
 * locked with a test without mounting a component or touching the DOM --
 * this repo's frontend tests run under Vitest's default (node) environment,
 * no jsdom, so anything that needs `document`/`window` has to live in the
 * component and stay untested at that layer, matching how
 * dispatch-dialog.test.tsx already tests only the pure helpers next to it.
 */

export type SheetAnchor = "right" | "popover";

// A swipe that hasn't cleared this fraction of the sheet's own height snaps
// back instead of dismissing -- "most of the way down", not a fixed pixel
// amount, so a short filter sheet and a tall one both feel right. The floor
// keeps a short sheet from dismissing on a barely-there flick.
const SWIPE_DISMISS_FRACTION = 0.3;
const SWIPE_DISMISS_MIN_PX = 60;

export function shouldDismissSwipe(deltaY: number, sheetHeight: number): boolean {
  if (deltaY <= 0 || sheetHeight <= 0) return false;
  const threshold = Math.max(SWIPE_DISMISS_MIN_PX, sheetHeight * SWIPE_DISMISS_FRACTION);
  return deltaY >= threshold;
}

export function isDismissKey(key: string): boolean {
  return key === "Escape";
}

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab / Shift+Tab focus-trap index, wrapping at both ends. `current` is
 *  -1 when focus is outside the trapped set (e.g. still on the backdrop),
 *  which this treats as "before the first item" so Tab enters at 0 and
 *  Shift+Tab enters at the last item. */
export function nextTrapIndex(current: number, count: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shiftKey ? count - 1 : 0;
  const next = shiftKey ? current - 1 : current + 1;
  return ((next % count) + count) % count;
}

export const SHEET_LAYOUT = {
  backdrop: "fixed inset-0 z-[90]",
  // Mobile: always a bottom sheet, full-bleed, safe-area padded. Desktop
  // (md and up): a fixed-width right-hand panel -- the anchor prop only
  // changes what happens at md+, per design guide §05.
  panelRight:
    "fixed inset-x-0 bottom-0 z-[95] flex max-h-[88dvh] flex-col rounded-t-card border-t pb-[env(safe-area-inset-bottom,0px)] shadow-overlay outline-none " +
    "md:inset-x-auto md:inset-y-0 md:bottom-auto md:left-auto md:right-0 md:h-dvh md:max-h-none md:w-[460px] md:rounded-none md:rounded-l-card md:border-l md:border-t-0 md:pb-0",
  // Desktop popover variant: still a full-bleed bottom sheet below `md`,
  // but a small anchored card above it (filters, quick pickers) instead of
  // a full-height panel.
  panelPopover:
    "fixed inset-x-0 bottom-0 z-[95] flex max-h-[88dvh] flex-col rounded-t-card border-t pb-[env(safe-area-inset-bottom,0px)] shadow-overlay outline-none " +
    "md:absolute md:inset-x-auto md:bottom-auto md:max-h-[min(560px,80dvh)] md:w-[380px] md:rounded-card md:border-t md:pb-0",
  dragArea: "flex flex-none flex-col md:hidden",
  handleTrack: "flex min-h-11 flex-none items-center justify-center",
  handleBar: "h-1 w-9 rounded-full bg-border-strong",
  header: "flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4",
  title: "m-0 font-serif text-xl text-fg",
  close: "grid h-[26px] w-[26px] flex-none place-items-center rounded-full border-0 bg-transparent p-0 text-fg-faint",
  body: "min-h-0 flex-1 overflow-y-auto",
  footer: "flex-none border-t border-border px-5 py-4",
} as const;

export function sheetPanelClass(anchor: SheetAnchor): string {
  return anchor === "popover" ? SHEET_LAYOUT.panelPopover : SHEET_LAYOUT.panelRight;
}
