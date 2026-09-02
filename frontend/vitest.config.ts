import path from "node:path";
import { defineConfig } from "vitest/config";

// Without this, `@/...` imports (the alias tsconfig.json declares under
// compilerOptions.paths, and that every component/page in this app uses)
// only resolve for Next.js's own build/dev server -- Vitest doesn't read
// tsconfig paths on its own. Any test file that imports a component
// pulling in an `@/...` import (most of them do) fails at load time with
// "Failed to load url @/... Does the file exist?", not a real assertion
// failure, so it looked like component-level tests just weren't possible
// here rather than a one-line config gap.
export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  // An explicit (if otherwise-default) `test` block, not just cosmetic:
  // Knip's Vitest plugin only registers `**/*.test.{ts,tsx}` as entry
  // points when `cfg.test` is present at all -- without it, every test
  // file gets reported as an "unused file" and its imports don't count as
  // usage of the source they exercise.
  test: {},
});
