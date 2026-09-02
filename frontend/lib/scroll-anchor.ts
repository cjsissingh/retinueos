/**
 * Pure scroll-position math for keeping the chat transcript pinned to its
 * latest message across keyboard open/close and new-message arrivals
 * -- deliberately not `scrollIntoView`, which animates/jumps and
 * fights the browser's own scroll-to-focused-field behavior on iOS Safari.
 * The component instead reads `isNearBottom` on scroll to remember whether
 * the reader was following along, then -- only if so -- restores scroll
 * with `bottomScrollTop` after a layout change (a new message, or the
 * keyboard resizing the transcript).
 */

// Anything within this many px of the true bottom still counts as "reading
// the latest message" -- a reader who scrolled up into history isn't
// yanked back down by a keyboard toggle or another arrival.
const NEAR_BOTTOM_THRESHOLD_PX = 48;

export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - clientHeight - scrollTop <= NEAR_BOTTOM_THRESHOLD_PX;
}

export function bottomScrollTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}
