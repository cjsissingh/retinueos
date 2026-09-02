/**
 * Layout tokens for `/today`. Single column, max ~720px per the
 * design doc §01 — narrower than the rest of the app's `max-w-content`
 * (1120px, `lib/touch-layout.ts`'s `PAGE_PAD`), since a decision queue reads
 * worse stretched wide. Kept here, not inlined, so the width contract has a
 * test per design guide's "Adding a screen" checklist.
 */

export const TODAY_LAYOUT = {
  page: "mx-auto flex max-w-[720px] flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8",
  greeting: "flex flex-col gap-1.5",
  section: "flex flex-col gap-3",
  sectionHeading: "m-0 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-fg-faint",
  sectionHeadingRule: "h-px flex-1",
  sectionList: "flex flex-col gap-4",
} as const;
