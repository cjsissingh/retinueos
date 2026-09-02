import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");

describe("interface guideline foundations", () => {
  it("provides touch feedback and honors reduced-motion preferences", () => {
    expect(globals).toContain("touch-action: manipulation");
    expect(globals).toContain("-webkit-tap-highlight-color");
    expect(globals).toContain("prefers-reduced-motion: reduce");
  });

  it("provides a keyboard skip link to the application content", () => {
    expect(shell).toContain('href="#main-content"');
    expect(shell).toContain('id="main-content"');
  });
});
