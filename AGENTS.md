# Agent instructions

Canonical project instructions for contributors and coding agents. Nested
`backend/AGENTS.md` and `frontend/AGENTS.md` add package-specific detail.

## What this repo is

**RetinueOS** is a local-first, self-hostable, persona-driven personal agent
control plane. Bring your own LLM keys. Use **RetinueOS** in user-facing copy
and **`retinueos`** for machine identifiers.

Two independent npm packages — **no root `package.json` / workspaces**. Install
and run commands from inside `backend/` or `frontend/`.

| Path        | Stack                                                            |
| ----------- | ---------------------------------------------------------------- |
| `backend/`  | TypeScript, Hono, LangGraph.js, Drizzle, Postgres, Vercel AI SDK |
| `frontend/` | Next.js 16 App Router, React 19, Tailwind (semantic tokens)      |
| `docs/`     | Working notes. Code + tests beat these when they disagree.       |

## Commands

Local app (Postgres in Docker, backend/frontend native with HMR):

```bash
cp .env.example .env   # AUTH_PASSWORD + at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY
./scripts/dev.sh
```

Per package (`cd backend` or `cd frontend`):

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint (config: <pkg>/.oxlintrc.json)
npm run lint:fix     # backend and frontend
npm run format       # prettier --write (root .prettierrc.json, printWidth 120)
npm run format:check
npm test             # vitest
```

CI (`.github/workflows/ci.yml`) runs all of those on both packages, plus
`next build` for the frontend. **Node 24** is required: oxlint loads
`tools/oxlint/anti-slop/index.ts` directly, which Node 20 cannot import.
If lint dies with `Unknown file extension .ts`, you are on the wrong Node.

Backend tests need real Postgres. Default is testcontainers (`postgres:16`).
If Docker cannot reach that registry, set `LOCAL_TEST_DATABASE_URL`. CI uses
that escape hatch against a service container.

Schema change:

```bash
cd backend
# edit src/db/schema.ts, then:
npm run db:generate   # drizzle-kit generate — do not hand-write drizzle/*.sql
npm run db:migrate    # for a running local DB
```

## Architecture (where to look)

- **HTTP**: `backend/src/app.ts` mounts routes. Zod at the boundary
  (`*-schemas.ts`), persistence in `*-repo.ts`, orchestration in
  `orchestration/` and `graph/`.
- **Jobs**: `jobs` → `job_attempts` (lease/heartbeat) → `JobWorker`. SSE via
  `job_events` + `Last-Event-ID` replay (`stream/stream-routes.ts`).
- **Tools**: `tools/registry.ts` (`ToolSpec`). Native tools in `builtin.ts`,
  `memory-tools.ts`, `routine-tools.ts`. External tools are **MCP only**
  (`tools/mcp-*.ts`, UI at `/settings/mcp`). Do not revive hand-coded Gmail /
  Calendar tools; see `docs/CONNECTORS.md`.
- **Approvals**: destructive tools interrupt the graph and write
  `tool_calls`. A destructive tool cannot be stored as Allow
  (`tools/autonomy.ts`) — Ask is the ceiling.
- **Control plane MCP**: inbound Streamable HTTP at
  `${BACKEND_URL}/mcp/control` — the **backend origin**, never the frontend
  host. Operator guide: `docs/CONTROL_PLANE_MCP.md`. Code: `backend/src/control/`.
- **Frontend API types** live in `frontend/lib/api-client.ts`, duplicated from
  the backend by design (no shared package). Change both in the same PR.
- **UI tokens**: `frontend/app/globals.css` + `tailwind.config.ts`. Use
  `bg-bg`, `text-fg`, `text-accent`, `border-border`, `bg-danger-soft`, etc.
  Never raw `slate-*` / `amber-*` / `red-*`.

## Conventions

- Match the file you are in: comment to explain _why_ (history, invariant,
  rejected alternative), not _what_. Existing comments are the style guide.
- Prettier `printWidth` 120. Do not reformat files you did not change.
- **anti-slop** oxlint plugin is on (vendored at `<pkg>/tools/oxlint/anti-slop`).
  Do not add `as T` without a safety comment, `any`/`unknown`/`object` as a
  parameter or return type, chained assertions, or `Record<string, any>`.
  `Record<string, unknown>` is allowed only for genuinely dynamic JSON (tool
  arguments/results). Overrides live in `.oxlintrc.json` with a rationale
  comment — if you disable a rule, do the same.
- Backend is ESM `NodeNext`: import with the `.js` specifier
  (`import { x } from "./foo.js"`) even though the source is `.ts`.
- Do not edit `backend/drizzle/**` by hand, lockfiles, or the vendored
  anti-slop trees. Do not format those either (`.prettierignore`).
- Do not add a root workspace or merge backend and frontend into one package.

## Testing

- Backend: `backend/tests/*.test.ts` with `useTestDb()` from
  `tests/setup/db.ts`. One Postgres, truncated between tests. Mock `generateText`
  (the `ai` SDK) to drive graphs without a live model — that mock is an
  explicit oxlint exemption, not a pattern to copy into the frontend.
- Frontend: `frontend/tests/*.test.ts(x)`, Vitest, `@/` alias. Prefer
  testing behavior of components/lib, not snapshots of whole pages.
- If you change behavior, add or update a test in the same PR. Look at the
  nearest existing test file before inventing a new harness.

## Product invariants

- Single shared `AUTH_PASSWORD`. Not multi-tenant.
- MCP: remote HTTPS only. No local stdio servers. SSRF/DNS-rebinding checks
  in `mcp-url.ts` / `mcp-client.ts` are load-bearing — do not "simplify" them.
- Delegation depth and descendant caps are real (not just prompt text).
- Reporting graph: `personas.reports_to` is acyclic; cycle checks live in
  `persona-repo.ts`, not the DB.
- User-visible strings say **RetinueOS**. Branded identifiers use `retinueos`.

## Docs — what to trust

1. **Code and tests** (always).
2. `README.md`, `docs/CONNECTORS.md`, `docs/CONTROL_PLANE_MCP.md`.

## Git and parallel agents

`.worktrees/` is gitignored for isolated parallel sessions. Check for other
active sessions and open pull requests before merging to `main`.

Do not commit `.env`, local overrides, credentials, or other secrets.

## Before you finish

Run from each package you touched:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

Frontend PRs that affect the UI or `next.config.ts` also need `npm run build`.
If you changed `schema.ts`, confirm `npx drizzle-kit check` is clean and that
`db:generate` produced a new migration.
