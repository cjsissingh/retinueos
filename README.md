# RetinueOS

Persona-driven personal agent control plane. Local-first, self-hostable, and provider-agnostic: bring your own LLM API
keys.

A TypeScript/Hono backend orchestrates personas via LangGraph.js; a Next.js frontend talks to it over REST and SSE. Both deploy via Docker Compose. Standing architecture decisions live in [`docs/adr/`](docs/adr/README.md).

**What this is:** a small staff of persona-shaped agents you hire, assign tools to, and delegate work to — with every destructive action gated behind your approval by default. **What this isn't:** a general chat UI, a multi-tenant SaaS (one shared password, one operator), or a place to run arbitrary local/stdio MCP servers or hand-coded connectors — external tools are remote HTTPS MCP servers only. See [`docs/OPERATING.md`](docs/OPERATING.md) for how personas, routines, approvals, and connections actually work day to day.

These docs are also browsable at [docs.retinueos.com](https://docs.retinueos.com) — the same content, nicer reading experience. This repo's `docs/` stays the source of truth.

## Quick start

```bash
cp .env.example .env
# edit .env: set AUTH_PASSWORD and at least one LLM provider key
# (ANTHROPIC_API_KEY and/or OPENAI_API_KEY)

docker compose up --build
```

Then visit `http://localhost:3000`. If neither provider key is set, the app
still lets you sign in with `AUTH_PASSWORD`, but blocks every other page
behind a "no one's able to work yet" screen with the same instructions
above, rather than letting you hire personas and dispatch jobs that would
otherwise just fail silently once they reach the model call.

That's enough for a local, `localhost`-only install. Putting RetinueOS on a
server — every env var, HTTPS/reverse-proxy setup, and connecting Google —
is [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

Compose binds all three published ports to `127.0.0.1` by default. Setting
`HOST_BIND_ADDRESS=0.0.0.0` is an explicit opt-in to expose the frontend,
backend, and Postgres on every host interface; secure the database and use
HTTPS before choosing that setting.

## Browser notifications

RetinueOS is an installable PWA and can send explicitly requested job and
routine outcomes to every browser device you enable. Generate one VAPID key
pair from the backend package:

```bash
cd backend
npx web-push generate-vapid-keys
```

Put the resulting values in `.env` as `VAPID_PUBLIC_KEY` and
`VAPID_PRIVATE_KEY`, and set `VAPID_SUBJECT` to an operator contact URI such
as `mailto:you@example.com`. All three must be present. Rebuild/restart the
backend after changing them:

```bash
docker compose up --build -d
```

Then open **Settings → Notifications** and choose **Enable notifications on
this device**. Repeat on every phone, tablet, or desktop that should receive
alerts. RetinueOS asks for browser permission only after that click. Every new
manual task and chat turn has its own unchecked **Notify me when this
finishes** control; routines use their existing direct-notification switch.
Selected attempts notify on every terminal outcome, including approval waits,
failures, timeouts, cancellation, and unknown outcomes—not only success.

Web Push requires a secure browser context (HTTPS; localhost is the usual
development exception). On iPhone and iPad, add RetinueOS to the Home Screen,
open that installed app, and enable notifications there. See the
[WebKit platform notes](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
and [MDN Notifications guidance](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API).

`NOTIFY_WEBHOOK_URL` remains an independent optional destination. Delivery is
fan-out: every enabled browser plus the webhook is attempted separately, and
one destination failing does not block the others. RetinueOS records each
attempt but does not automatically retry failed notification delivery; expired
browser subscriptions are removed after a permanent push-provider response.

## Development

Native development requires Node.js 24.

Both `backend/` and `frontend/` are independent npm packages (no root
package.json / workspaces — install and run commands from inside each) with
the same four scripts:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint (backend/frontend/.oxlintrc.json)
npm run format      # prettier --write   (format:check for CI-style verification)
npm test            # vitest
```

Formatting (Prettier) and linting (oxlint) share a `.prettierrc.json` /
per-package `.oxlintrc.json` at the repo root and package roots respectively
— both are fast enough to run on every save; there's no watch mode wired up
beyond editor integration. `.github/workflows/ci.yml` runs all four, plus
`next build`, for both packages on every push to `main` and every pull
request — a PR branched before this existed won't pick it up until it's
rebased onto (or has `main` merged into) a commit that includes the
workflow file.

The backend suite needs a real Postgres; `backend/tests/setup/global-
setup.ts` spins one up via testcontainers by default, or set
`LOCAL_TEST_DATABASE_URL` to point at one you already have running (what CI
itself does, and the escape hatch for a sandbox whose Docker can't reach the
testcontainers registry).

## Architecture

Standing decisions are in [`docs/adr/`](docs/adr/README.md): LangGraph.js
per-persona execution, MCP adapters for external tools, three separate
memory stores, autonomy that can only tighten, and a shared control-plane
policy layer for REST / MCP / native tools.

Connect Gmail, Calendar, or any other remote MCP server from
**Settings → Connections** (`/settings/mcp`). Operator setup is
[`docs/CONNECTORS.md`](docs/CONNECTORS.md). Custom-script connectors,
browser-agent tools, and local stdio MCP servers are not in this release.

External MCP clients connect _into_ RetinueOS at
`${BACKEND_URL}/mcp/control` with a bearer token from
**Settings → Access**. That is the backend origin, not the app host — on a
split-origin deploy, `https://api.example.com/mcp/control`, never the
frontend hostname. Operator setup is
[`docs/CONTROL_PLANE_MCP.md`](docs/CONTROL_PLANE_MCP.md).

## Self-hosting

Deployment specifics — every env var, Web Push, HTTPS/reverse proxies, and
connecting Google — are in [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).
This section only covers identifier stability.

Self-host URLs remain configurable through `FRONTEND_ORIGIN`, `NEXT_PUBLIC_BACKEND_URL`, and `BACKEND_URL`. App routes
include `/roster`, `/settings/mcp`, `/oauth/callback`, and `/mcp/control`.
