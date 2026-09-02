# Frontend (`retinueos-frontend`)

Next.js 16 App Router. Talks to the backend over REST + SSE only — never
Postgres. Types for that API are **hand-duplicated** in `lib/api-client.ts`;
keep them in lockstep with backend route/schema changes in the same PR.

## Layout

| Area        | Path                                                         |
| ----------- | ------------------------------------------------------------ |
| Routes      | `app/**/page.tsx` (Roster, Approvals, Logs, Audit, Settings) |
| Shell / nav | `components/app-shell.tsx`, `app/layout.tsx`                 |
| UI pieces   | `components/`, primitives under `components/ui/`             |
| API + auth  | `lib/api-client.ts`, `lib/auth.ts`                           |
| Tokens      | `app/globals.css`, `tailwind.config.ts`                      |
| Tests       | `tests/*.test.ts(x)`                                         |

Imports use the `@/` alias (`@/components/app-shell`). Vitest is configured
to resolve it; do not switch those to relative paths "for the test".

## UI

- Semantic Tailwind tokens only: `bg-bg`, `bg-surface`, `text-fg`,
  `text-fg-muted`, `border-border`, `text-accent`, `bg-danger-soft`,
  `bg-warning-soft`, `bg-success-soft`, `bg-running-soft`, etc. No `slate-*`,
  `amber-*`, `red-*`, or raw hex in components (hex belongs in `globals.css`).
- This should feel like managing a small staff, not an admin table. Personas
  are people; approvals are high-stakes.
- Touch: use sizes from `lib/touch-layout.ts` (~44px targets). Do not shrink
  the chat transcript to make room for chrome on mobile.
- `'use client'` only where state, effects, or browser APIs need it. Keep
  the leaf presentational when you can.
- `react/set-state-in-effect` is off — pages load on mount via `load()`
  callbacks. Follow that pattern rather than inventing a cache library.

## Tests

Vitest + the `@/` alias. Frontend **does** enforce `anti-slop/no-module-mocking`
— do not `vi.mock` a module to dodge a seam. Stub `fetch` / `EventSource` at
the network boundary (see `tests/api-client.test.ts`) instead.
