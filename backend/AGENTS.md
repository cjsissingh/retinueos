# Backend (`retinueos-backend`)

Hono + LangGraph.js + Drizzle, ESM (`"type": "module"`, `module: NodeNext`).
Every local import needs a `.js` specifier: `from "./persona-repo.js"`.

## Layout

| Area          | Path                                                   |
| ------------- | ------------------------------------------------------ |
| Route wiring  | `src/app.ts`, `src/server.ts`                          |
| HTTP + Zod    | `src/**/*-routes.ts`, `src/**/*-schemas.ts`            |
| Persistence   | `src/**/*-repo.ts`, `src/db/schema.ts`                 |
| Graph / jobs  | `src/graph/`, `src/orchestration/`, `src/jobs/`        |
| Tools         | `src/tools/` (`registry.ts`, `builtin.ts`, `mcp-*.ts`) |
| Control plane | `src/control/` (also served at `/mcp/control`)         |
| Tests         | `tests/*.test.ts`, `tests/setup/`                      |

`createApp` takes optional scheduler / db / worker / controlPlane so tests
can inject fakes without booting `server.ts`.

## Patterns

- Validate with Zod at the HTTP (or tool) boundary; pass named types inward.
  Do not type a function parameter as `object` or `unknown` — anti-slop will
  fail CI.
- New tables/columns: edit `src/db/schema.ts`, then `npm run db:generate`.
  Never hand-write `drizzle/*.sql`. Migration filenames are drizzle-kit's
  (currently through `0020_*.sql`); collisions from parallel branches have
  happened before — rebase and regenerate rather than renaming by hand.
- LangGraph checkpointer tables are **not** Drizzle-managed. Do not add them
  to `schema.ts`. Tests that create them must truncate them in `useTestDb`.
- Tool execution goes through `ToolRegistry` + `tool_calls`. Destructive →
  interrupt + approval. Do not bypass that for "just this call".
- `delegate_to` is intercepted by the dispatcher (`onDelegate`), not executed
  by `builtin.ts`'s `run`. Resolve targets by UUID, exact name, or unambiguous
  slug before inserting a child job.
- Native tools: `get_weather`, `send_email` (mocked), `delegate_to`,
  `read_state` / `write_state` / `list_state` / `forget_state`, `remember` /
  `recall` / `forget_memory` / `promote_memory`, and the `*_own_routine*`
  family. Everything else should come in through MCP.

## Tests

`vitest run` provisions one Postgres database per worker (`tests/setup/global-setup.ts`,
`WORKER_COUNT` kept in sync with `maxWorkers` in `vitest.config.ts`) so test
files run in parallel without racing each other's `TRUNCATE`. `useTestDb()`
opens one pool per file (`beforeAll`/`afterAll`) and truncates between tests
(`afterEach`) for isolation — don't move `createDb` back into `beforeEach`
without a reason; that was a real perf regression once already. Prefer
inserting through repos/routes over duplicating SQL. Graph tests mock
`generateText`; that is the allowed module-mock. Do not `vi.mock` random
internals to avoid designing a seam.
