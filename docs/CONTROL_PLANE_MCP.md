# Control-plane MCP

How to connect an external MCP client **into** RetinueOS so it can inspect personas, run jobs, manage routines, and
resolve approvals. Architecture is [ADR 0005](adr/0005-control-plane-shared-policy.md). This doc is the operator how-to.

This is the opposite of [Connectors](CONNECTORS.md). Connections lets a
RetinueOS persona call an _outbound_ MCP server (Gmail, Calendar, …). This
page is the _inbound_ control plane. Personas never call `/mcp/control`; they
use native tools.

## Endpoint

```text
${BACKEND_URL}/mcp/control
```

`BACKEND_URL` is the backend origin — the same host as `NEXT_PUBLIC_BACKEND_URL`.
Transport is Streamable HTTP. There is no stdio server.

| Setup                   | App (frontend)            | MCP URL                               |
| ----------------------- | ------------------------- | ------------------------------------- |
| Local Compose           | `http://localhost:3000`   | `http://localhost:8080/mcp/control`   |
| Split-origin production | `https://app.example.com` | `https://api.example.com/mcp/control` |

**Use the API host, not the app host.** Pointing an MCP client at the frontend origin returns a Next.js HTML 404.

The **Access** page (`/settings/access`) shows the correct URL for the running
instance.

Quick check that you hit the backend, not Next.js:

```bash
curl -sS -D - -o /dev/null https://api.example.com/mcp/control
```

Expect HTTP `401` with `Content-Type: application/json` and
`{"error":"invalid or missing bearer token"}`. HTML `404` means the frontend
host.

## Create a token

1. Open **Access** (`/settings/access`).
2. Name the client (for example `Desktop client`).
3. Select scopes. Choosing a write scope also selects its matching read
   scope in the form; the server still enforces each scope independently.
4. Click **Create token** and copy it immediately. RetinueOS shows the
   plaintext once.

Token shape: `retinueos_live_<12-character-prefix>_<43-character-secret>`.

Every MCP request needs:

```http
Authorization: Bearer retinueos_live_…
```

Do not put the token in the query string. Missing, invalid, or revoked
credentials return HTTP `401`. Revoke from the same Access page; the next
request fails.

## Scopes

Discovery returns only tools the token is allowed to call. A `jobs:write`
token can create a job but cannot inspect it unless it also has `jobs:read`.

| Scope             | Tools                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `personas:read`   | `retinueos_personas_list`, `retinueos_personas_get`                                                                                                                      |
| `jobs:read`       | `retinueos_jobs_list`, `retinueos_jobs_get`                                                                                                                              |
| `jobs:write`      | `retinueos_jobs_create`, `retinueos_jobs_continue`, `retinueos_jobs_cancel`                                                                                              |
| `routines:read`   | `retinueos_routines_list`                                                                                                                                                |
| `routines:write`  | `retinueos_routines_create`, `retinueos_routines_update`, `retinueos_routines_pause`, `retinueos_routines_resume`, `retinueos_routines_run`, `retinueos_routines_delete` |
| `approvals:read`  | `retinueos_approvals_list`                                                                                                                                               |
| `approvals:write` | `retinueos_approvals_resolve`                                                                                                                                            |
| `audit:read`      | `retinueos_audit_list`                                                                                                                                                   |

A useful default is personas + jobs + routines + approvals (read and write) if the client should operate the control
plane. Use read-only scopes when it should only inspect. Configure an HTTP MCP server in your client with the URL and
authorization header below:

```json
{
  "mcpServers": {
    "retinueos": {
      "url": "https://api.example.com/mcp/control",
      "headers": {
        "Authorization": "Bearer retinueos_live_your_token"
      }
    }
  }
}
```

Replace the URL with your `BACKEND_URL` plus `/mcp/control`, then reload the client's MCP configuration.

## Constraints

- **HTTPS outside localhost.** A non-local `BACKEND_URL` must be `https://`.
- **Origin.** CLI clients that omit `Origin` are fine. If a client sends
  `Origin`, it must match `FRONTEND_ORIGIN` or the origin of `BACKEND_URL`.
  A browser page from some other host gets `403 untrusted Origin`.
- **No OAuth yet.** Manual bearer tokens work for HTTP MCP clients.
- **No stdio.** Clients that can only spawn a local process cannot connect
  without their own HTTP bridge.
- **No query credentials.** `token`, `access_token`, and `password` query
  parameters are rejected before the header is read.
