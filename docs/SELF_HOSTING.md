# Self-hosting RetinueOS

Deploying RetinueOS somewhere other than your own laptop: every env var,
Web Push, and running it behind HTTPS. For local development instead, the
[README Quick start](../README.md#quick-start) is enough — come back here
once you're putting it on a server.

## Prerequisites

- Docker and Docker Compose (`docker compose`, the plugin form).
- At least one LLM provider key: `ANTHROPIC_API_KEY` and/or
  `OPENAI_API_KEY`. Without either, RetinueOS still lets you sign in but
  blocks everything else — there's no persona work it could do.
- A domain or IP you control, if this needs to be reachable from outside
  the host. Web Push and any OAuth-based connector (Gmail, Calendar)
  require a real HTTPS origin — see [HTTPS and reverse proxies](#https-and-reverse-proxies).

## Environment variables

`.env.example` is the source of truth — each var is documented inline
there, and `docker-compose.yml` wires all of them into the `backend` and
`frontend` services. Copy it and fill in what applies:

```bash
cp .env.example .env
```

| Variable                                                          | Required                              | What it's for                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PASSWORD`                                                   | Yes                                   | The one shared password gating the whole app (not multi-tenant).                                                                                                                                                                 |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`                            | At least one                          | Your own LLM provider keys. Personas run on whichever model you assign.                                                                                                                                                          |
| `BRAVE_SEARCH_API_KEY`                                            | No                                    | Enables the built-in `web_search` tool.                                                                                                                                                                                          |
| `CREDENTIALS_ENCRYPTION_KEY`                                      | Only for authenticated MCP connectors | AES key for storing an MCP server's bearer token or OAuth client secret. Generate with `openssl rand -base64 32`. An unauthenticated MCP server doesn't need it; adding one that does, without this key set, fails at save time. |
| `BACKEND_URL`                                                     | For OAuth connectors                  | The backend's externally-reachable origin; builds the `/oauth/callback` redirect URI. Must exactly match what you register with the OAuth provider.                                                                              |
| `FRONTEND_ORIGIN`                                                 | Yes, if not on defaults               | Origin the backend allows via CORS — the browser-visible frontend URL.                                                                                                                                                           |
| `NEXT_PUBLIC_BACKEND_URL`                                         | Yes, if not on defaults               | Public URL the browser uses to reach the backend. Inlined into the frontend bundle at **build** time — changing it needs `docker compose build frontend`, not just a restart.                                                    |
| `HOST_BIND_ADDRESS`                                               | No                                    | Address for every Compose-published host port. Defaults to loopback (`127.0.0.1`). Set `0.0.0.0` only to deliberately expose all three services, including Postgres, on every interface.                                         |
| `POSTGRES_HOST_PORT` / `BACKEND_HOST_PORT` / `FRONTEND_HOST_PORT` | No                                    | Host ports published by Compose; defaults are `5432`, `8080`, and `3000`. Container ports and service-to-service URLs do not change.                                                                                             |
| `NOTIFY_WEBHOOK_URL`                                              | No                                    | Webhook destination for job/routine outcomes (e.g. an [ntfy.sh](https://ntfy.sh) topic).                                                                                                                                         |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`        | No, all three together                | Standards-based Web Push to browser devices. See below.                                                                                                                                                                          |

Defaults (`http://localhost:3000` / `http://localhost:8080`) are correct
for running Compose on your own machine and nowhere else.

## Web Push (VAPID)

Browser push notifications need one VAPID key pair, generated once:

```bash
cd backend
npx web-push generate-vapid-keys
```

Put the public/private key in `.env` as `VAPID_PUBLIC_KEY` /
`VAPID_PRIVATE_KEY`, and set `VAPID_SUBJECT` to an operator contact URI
(`mailto:you@example.com`). All three are required together — partial
config leaves push disabled. Rebuild and restart after changing them:

```bash
docker compose up --build -d
```

Then, per device, open **Settings → Notifications** and enable
notifications on that device — RetinueOS only asks the browser for
permission after that click. `NOTIFY_WEBHOOK_URL` is independent of this
and keeps working with or without VAPID configured; both destinations are
attempted separately and one failing doesn't block the other.

Web Push requires a secure browser context. On a real deployment that
means HTTPS (see below); `localhost` is the only exception. On iPhone/iPad,
Home Screen install is required before notifications can be enabled at
all — see the
[WebKit platform notes](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Connecting Google (Gmail, Calendar) and other MCP servers

External tools — Gmail, Calendar, anything else — are added per persona
through **Connections** (`/settings/mcp`), not env vars. Only remote HTTPS
MCP servers are supported; there's no local stdio option. Full walkthrough,
including the Google-hosted servers (Developer Preview) and a self-hosted
fallback:

- [`docs/CONNECTORS.md`](CONNECTORS.md) — the general mechanism and the
  Google-hosted Gmail/Calendar servers.
- [`docs/SELF_HOSTED_GOOGLE_WORKSPACE_MCP.md`](SELF_HOSTED_GOOGLE_WORKSPACE_MCP.md) —
  run your own Google Workspace MCP server if your project isn't enrolled
  in the Developer Preview.

`CREDENTIALS_ENCRYPTION_KEY` (above) must be set before you can save a
connector's credentials.

## HTTPS and reverse proxies

RetinueOS itself doesn't terminate TLS — `backend` and `frontend` are
plain HTTP inside Compose, on ports `8080` and `3000`. Put a reverse proxy
(Caddy, nginx, Traefik) in front for anything beyond `localhost`. Two
things depend on this directly:

- **The auth password travels as a header** (`X-Auth-Password`) on every
  request, not a cookie. Over plain HTTP, that's a plaintext password on
  the wire.
- **Web Push requires a secure context** — browsers refuse to register a
  push subscription over insecure HTTP.

By default, `docker-compose.yml` binds its three published ports to
`127.0.0.1`, so they are reachable only from the host. This keeps Postgres's
local-development credentials off external interfaces and lets a reverse
proxy running on the host reach the app without exposing its plain-HTTP
ports directly. `HOST_BIND_ADDRESS=0.0.0.0` is an explicit opt-in that makes
the frontend, backend, and Postgres reachable on every interface; do not use
it unless the database and both app ports are independently protected.

When the reverse proxy is another Compose service, remove the `postgres`,
`backend`, and `frontend` `ports:` entries entirely. Compose services already
reach each other by name over the internal network, so only the proxy needs a
host port. Compose merges override-file list fields (`ports` included) by
concatenating them, so edit the base file rather than trying to clear those
entries in an override. Add the proxy as its own service in the same file:

```yaml
# docker-compose.yml — add alongside the existing services.
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80" # ACME HTTP challenge
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

volumes:
  caddy_data:
```

Separate subdomains for the app and the API are the simplest correct
routing — each proxies straight through, with no path-rewriting to get
wrong:

```caddyfile
app.example.com {
    reverse_proxy frontend:3000
}

api.example.com {
    reverse_proxy backend:8080
}
```

with `FRONTEND_ORIGIN=https://app.example.com`,
`BACKEND_URL=https://api.example.com`, and
`NEXT_PUBLIC_BACKEND_URL=https://api.example.com`. That's the same
split used for the control-plane MCP endpoint; see the
[app-vs-MCP host table](CONTROL_PLANE_MCP.md#endpoint) for a worked
example. A single domain with the backend under a
path prefix (`/api/*`) works too, but the backend's own routes are
top-level (`/personas`, `/jobs`, `/oauth/callback`, …) — that needs the
prefix actually stripped before RetinueOS ever sees the request (Caddy's
[`handle_path`](https://caddyserver.com/docs/caddyfile/directives/handle_path),
not a bare `reverse_proxy /api/*`), and every RetinueOS URL that includes
the path (`BACKEND_URL`, `NEXT_PUBLIC_BACKEND_URL`, the OAuth redirect URI)
needs it too.

Routes and environment-variable names remain unchanged when adding a reverse proxy.

## Data and upgrades

Postgres data lives in the named volume `retinueos_postgres_data` — back
that up like you would any database volume; there's no separate export
tool. Schema changes ship as Drizzle migrations, applied automatically on
backend startup. There's no published RetinueOS image — you build from
source — so upgrading is `git pull` followed by
`docker compose up --build -d`; there's no separate migration step to run
by hand.
