# anti-slop

Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT,
see `LICENSE`), commit as of 2026-08-22. These are Oxlint [JS plugin](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
rules that flag common "AI slop" TypeScript patterns -- type assertions that
launder `unknown`/`any` back into a narrow type without evidence, dictionary
value types left as `unknown`/`any`/`object`, module mocking in tests instead
of real dependency seams, `Reflect.get`/`Reflect.apply` used in place of
typed access, etc.

This is vendored on purpose, not installed as an npm dependency: it's meant
to be read, understood, and edited to fit this codebase, not treated as an
immutable third-party rule set. See `../../../.oxlintrc.json` for which
rules are enabled and any project-specific overrides (with rationale
comments, same as the rest of that file).

To update: re-fetch `index.ts`, `rules/*.ts`, and `shared/*.ts` from the
upstream `src/` directory and diff against what's here before overwriting,
same as any other vendored dependency.
