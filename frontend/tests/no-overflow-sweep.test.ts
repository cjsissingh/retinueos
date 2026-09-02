import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static proxy for the rule -- "no element wider than the viewport"
 * at 390px, on every route. The acceptance criterion as written --
 * `document.documentElement.scrollWidth <= document.documentElement.clientWidth`
 * -- needs a real layout engine: jsdom doesn't compute CSS box sizes (both
 * would always read 0 there, so the assertion would pass unconditionally
 * and catch nothing), and this repo's frontend tests intentionally run
 * without jsdom (see lib/sheet.ts). Every route here is also a client
 * component wired to next/navigation's router hooks, which need a real
 * Next app tree to render -- not something this harness has a seam for
 * without `vi.mock`ing next/navigation, which anti-slop/no-module-mocking
 * forbids.
 *
 * So this sweeps every route's own source for the concrete Tailwind shape
 * that causes a real 390px overflow: an arbitrary-value fixed-pixel width
 * or grid template with no responsive prefix (`sm:`/`md:`/`lg:`/
 * `shell-lg:`), wider than the viewport, on a class string that isn't
 * itself `hidden` below md (the desktop-only Logs table header is
 * exactly that shape: `hidden grid-cols-[130px_1fr_150px_100px_110px] ...
 * md:grid` never lays out below md at all, so its own declared width is
 * moot there). It intentionally does NOT flag `overflow-x-auto` --
 * self-contained horizontal scrollers (the filter chip row, plus
 * several pre-existing ones for wide tables/code) don't expand the
 * document's own width, which is the actual rule; only the org chart's
 * Structure view is allowed to make the page itself wider than the
 * viewport, and that lives outside `app/` entirely (components/org-chart.tsx).
 */

const SCAN_DIRS = [join(__dirname, "../app"), join(__dirname, "../components")];
const VIEWPORT_PX = 390;

// The org chart's Structure view is explicitly exempt from the no-overflow
// rule -- it's a diagram, not a data row, and is meant to pan.
const EXEMPT_FILES = new Set(["org-chart.tsx"]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (extname(entry) === ".tsx" && !EXEMPT_FILES.has(entry)) out.push(full);
  }
  return out;
}

// One `className="..."` or `className={`...`}` string per match.
const CLASS_STRING_PATTERN = /class(?:Name)?=(?:"([^"]*)"|\{`([^`]*)`\})/g;

// An unprefixed arbitrary-value width/grid-template token -- `w-[420px]`,
// `min-w-[420px]`, `grid-cols-[130px_1fr]` -- but not `md:w-[420px]` (a
// prefixed class only ever applies at its breakpoint and up, where 390px
// mobile doesn't exist).
const UNPREFIXED_WIDTH_TOKEN = /^(?:min-w|w|grid-cols)-\[([^\]]+)\]$/;

function maxDeclaredPx(bracketContents: string): number {
  const values = [...bracketContents.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
  return values.length > 0 ? Math.max(...values) : 0;
}

function findOverflowOffenders(source: string): string[] {
  const offenders: string[] = [];
  for (const classMatch of source.matchAll(CLASS_STRING_PATTERN)) {
    const classString = classMatch[1] ?? classMatch[2] ?? "";
    const tokens = classString.split(/\s+/).filter(Boolean);
    // `hidden` (unprefixed) means display:none below whatever breakpoint,
    // if any, un-hides it -- its own declared width never actually lays
    // out at 390px, so it can't cause a real overflow there.
    if (tokens.includes("hidden")) continue;
    for (const token of tokens) {
      const match = token.match(UNPREFIXED_WIDTH_TOKEN);
      if (match && maxDeclaredPx(match[1]) > VIEWPORT_PX) offenders.push(token);
    }
  }
  return offenders;
}

describe("no unintentional fixed-width overflow at 390px", () => {
  const files = SCAN_DIRS.flatMap(listFiles);

  it("scans at least one route/component file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relPath = relative(join(__dirname, ".."), file);
    it(`${relPath}: nothing rendered below md is wider than ${VIEWPORT_PX}px`, () => {
      const source = readFileSync(file, "utf8");
      expect(findOverflowOffenders(source)).toEqual([]);
    });
  }
});
