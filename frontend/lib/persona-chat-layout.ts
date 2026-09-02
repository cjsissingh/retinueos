/**
 * Chat page layout. The transcript and chat history stay conversational;
 * persona management has its own route instead of competing for space in
 * an icon rail or overlay. On narrow viewports only the chats list remains
 * a Sheet because it is navigation within this conversation surface.
 */
export const PERSONA_CHAT_LAYOUT = {
  page: "relative flex h-[calc(100dvh-2.75rem-env(safe-area-inset-bottom,0px))] min-w-0 max-w-full flex-col overflow-x-hidden md:h-dvh",
  header: "flex flex-none items-center gap-3 border-b px-4 py-3 sm:gap-5 sm:px-8 sm:py-5",
  body: "flex min-h-0 min-w-0 flex-1 flex-col md:flex-row",
  // Desktop-only now -- below md this is a Sheet (opened from the header's
  // "Chats" action) instead of an in-flow column.
  chatSidebar: "hidden min-w-0 flex-col border-r md:flex md:w-[260px]",
  chatColumn: "flex min-w-0 max-w-full flex-1 flex-col",
  transcript: "min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-10 sm:py-6",
  composer: "flex-none min-w-0 max-w-full border-t px-4 py-3 sm:px-10 sm:py-4",
  mobileHeaderAction:
    "inline-flex min-h-11 items-center justify-center rounded-button border px-3 font-sans text-[13px] font-medium md:hidden",
} as const;

/**
 * `page`'s `100dvh` already nets out Safari's own chrome (the URL bar
 * collapsing), but not a software keyboard -- `useKeyboardInset`
 * measures how much of the layout viewport the keyboard is covering, and
 * this shrinks the page by exactly that so the composer lands right above
 * it instead of underneath it. `undefined` below the threshold (no
 * keyboard) leaves the CSS class's own `100dvh`/`md:h-dvh` in charge, so
 * this never fights the desktop layout.
 */
export function keyboardAwarePageStyle(insetPx: number): { height: string } | undefined {
  if (insetPx <= 0) return undefined;
  return { height: `calc(100dvh - 2.75rem - env(safe-area-inset-bottom, 0px) - ${insetPx}px)` };
}
