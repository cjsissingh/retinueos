# Connectors

How to give a persona access to an external service via a remote MCP
server. The architectural constraint — every connector is a `ToolSpec`
through the same dispatch and audit path — is
[ADR 0002](adr/0002-external-tools-via-mcp-adapters.md). This doc is the
operator how-to. Gmail and Google Calendar are the two servers most people
want first.

To connect an external MCP client _into_ RetinueOS (the inbound control plane at `/mcp/control`), see
[Control-plane MCP](CONTROL_PLANE_MCP.md). That URL is the backend origin,
not this Connections page.

## The mechanism

1. Open **Connections** (`/settings/mcp`) and add a server: name, URL, and
   either a static bearer token or OAuth client settings.
2. RetinueOS does the MCP handshake (`initialize` → `tools/list`) and shows
   every tool the server exposes.
3. Confirm the `riskClass` (read-only / reversible / destructive) for each
   tool — RetinueOS pre-fills a guess from the server's own
   `readOnlyHint`/`destructiveHint`, but a server can misreport those, so
   this step isn't skippable. A tool isn't callable until this is set.
4. Approved tools become assignable to personas exactly like any other
   tool, flowing through the same approval/audit path.

Only remote HTTPS servers are supported (`mcp-url.ts` also blocks
private/loopback/link-local addresses and pins the validated address
against DNS-rebinding). A local stdio server is an arbitrary subprocess
with its own filesystem/network access on your host — deliberately out of
scope until that trust question gets its own pass.

## Gmail and Google Calendar through Google's hosted servers

Google hosts MCP servers for both products:

- Gmail: `https://gmailmcp.googleapis.com/mcp/v1`
- Calendar: `https://calendarmcp.googleapis.com/mcp/v1`

Both servers currently require the Google Workspace Developer Preview
Program. Use the self-hosted option below when your project isn't enrolled.

**Setup steps:**

1. Google Cloud Console → create an OAuth 2.0 client, type "Web application".
2. Enable the Gmail API + Gmail MCP API (for Gmail) or the Calendar API +
   Calendar MCP API (for Calendar).
3. Add `${BACKEND_URL}/oauth/callback` as an authorized redirect URI on
   that client — `BACKEND_URL` is RetinueOS's own env var (`.env.example`);
   whatever you set it to there must match exactly what you register here.
4. On `/settings/mcp`, add a server: URL is `https://gmailmcp.googleapis.com/mcp/v1`
   (or the Calendar equivalent), toggle to **OAuth**, click **Use Google
   preset** to fill the authorization/token endpoints and infer the right
   scope from the URL, then paste in the client ID and secret from step 1.
5. Click **Connect** on the new server row — this sends your browser to
   Google's consent screen and back; the tool catalog populates
   automatically once it completes.

See `developers.google.com/workspace/gmail/api/guides/configure-mcp-server`
and the Calendar equivalent for anything Google's side of this changes.

## Self-hosting Google Workspace connectors

You can run an independent Workspace MCP server against Google's generally
available APIs. This avoids the Developer Preview requirement and can expose
Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat,
Apps Script, and Custom Search from one container.

Follow [Self-host Google Workspace MCP](SELF_HOSTED_GOOGLE_WORKSPACE_MCP.md)
for a Docker, Caddy, OAuth, and RetinueOS configuration. Keep the deployment
files and credentials outside this repository. The guide uses generic
hostnames and placeholders so operators can adapt it to their environment.

## Adding other connectors

Any remote MCP server that takes a static bearer token (or none at all)
works today via the mechanism above — Slack, Notion, Linear, Drive, etc.
This doc will grow a section per connector as they get set up. A curated
in-app catalog is not built yet.
