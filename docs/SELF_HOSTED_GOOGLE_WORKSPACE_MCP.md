---
title: Self-host Google Workspace MCP
contentType: How-to
---

<!--
Content plan
Goal: Configure a private Google Workspace MCP server for RetinueOS without Google's Developer Preview Program.
Audience: RetinueOS operators who control a Docker host, DNS, and a Google Cloud project.
Plan: Explain the security boundary, deploy the container, configure OAuth, connect RetinueOS, and document limits.
Open questions: None.
-->

# Self-host Google Workspace MCP

This guide configures an independently maintained Google Workspace Model Context Protocol (MCP) server for RetinueOS. The server uses generally available Google APIs, so it doesn't require Google's Workspace Developer Preview Program.

## Understand the deployment boundary

Run the Workspace MCP container on the same host as RetinueOS, but expose it through a public HTTPS hostname. RetinueOS rejects private and loopback MCP URLs to prevent server-side request forgery (SSRF).

Use these controls:

- Bind the container port to host loopback
- Terminate Transport Layer Security (TLS) at a reverse proxy
- Require a random bearer token on `/mcp`
- Leave the Google OAuth callback reachable without the bearer token
- Store Google credentials and downloaded attachments in Docker volumes
- Pin the third-party image to a reviewed version or digest

This guide uses [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp). Review its source, releases, and security policy before upgrading.

## Configure Google Cloud

Create a Google Cloud project before starting the container:

1. Enable each Google API you plan to expose, such as Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, or People.
2. Configure the OAuth consent screen and add your account as a test user when the app is in testing mode.
3. Create an OAuth 2.0 client with the **Web application** type.
4. Add `https://workspace-mcp.example.com/oauth2callback` as an authorized redirect URI.
5. Save the client ID and client secret outside the repository.

Replace `workspace-mcp.example.com` with your MCP hostname. The redirect URI must match the configured public URL exactly.

## Configure the container

Create an unversioned environment file for the optional service:

```dotenv
GOOGLE_CLIENT_ID=your_google_oauth_client_id_here
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret_here
GOOGLE_USER_EMAIL=you@example.com
WORKSPACE_MCP_PUBLIC_URL=https://workspace-mcp.example.com
```

Create an unversioned Compose override beside your deployment configuration. This example grants Gmail draft access and write access to the other listed services. Reduce the permission levels to match your use case.

```yaml
services:
  workspace-mcp:
    image: ghcr.io/taylorwilsdon/google_workspace_mcp:1.24.1@sha256:bce81e3ba82be53a1363b3f06f831678156f5fe69225d2fe3dd952db560cdf15
    restart: unless-stopped
    ports:
      - "127.0.0.1:8001:8000"
    environment:
      GOOGLE_OAUTH_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOOGLE_OAUTH_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
      USER_GOOGLE_EMAIL: ${GOOGLE_USER_EMAIL}
      WORKSPACE_EXTERNAL_URL: ${WORKSPACE_MCP_PUBLIC_URL}
      GOOGLE_OAUTH_REDIRECT_URI: ${WORKSPACE_MCP_PUBLIC_URL}/oauth2callback
      WORKSPACE_MCP_CREDENTIALS_DIR: /credentials
      WORKSPACE_ATTACHMENT_DIR: /attachments
      WORKSPACE_MCP_HOST: 0.0.0.0
      WORKSPACE_MCP_PORT: 8000
      WORKSPACE_MCP_TOOL_TIER: complete
      WORKSPACE_MCP_PERMISSIONS: >-
        gmail:drafts calendar:full drive:full docs:full sheets:full
        slides:full forms:full tasks:manage contacts:full
    volumes:
      - workspace_mcp_credentials:/credentials
      - workspace_mcp_attachments:/attachments
    security_opt:
      - no-new-privileges:true

volumes:
  workspace_mcp_credentials:
  workspace_mcp_attachments:
```

The image runs as UID and GID `1000`. Initialize the new volumes before the first start so the container can write credentials and attachments:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.workspace-mcp.yml \
  --env-file .env.workspace-mcp \
  run --rm --user 0:0 --entrypoint sh workspace-mcp \
  -c 'chown 1000:1000 /credentials /attachments && chmod 700 /credentials && chmod 750 /attachments'
```

Start the service with the same environment file that supplies the variables:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.workspace-mcp.yml \
  --env-file .env.workspace-mcp \
  up -d workspace-mcp
```

## Protect the MCP endpoint with Caddy

Generate a bearer token and store it in `/etc/caddy/workspace-mcp.env`. Make the file readable by `root` and the Caddy service group, but not by other users. Don't commit this file.

```dotenv
WORKSPACE_MCP_BEARER_TOKEN=your_random_bearer_token_here
```

Create `/etc/systemd/system/caddy.service.d/workspace-mcp.conf` so the Caddy service loads the file:

```systemd
[Service]
EnvironmentFile=/etc/caddy/workspace-mcp.env
```

Reference the variable from the Caddyfile:

```caddyfile
workspace-mcp.example.com {
    @unauthorized {
        path /mcp /mcp/*
        not header Authorization "Bearer {$WORKSPACE_MCP_BEARER_TOKEN}"
    }

    respond @unauthorized "Unauthorized" 401
    reverse_proxy localhost:8001
}
```

The matcher protects MCP requests while allowing `/oauth2callback`. Bind port `8001` to loopback so clients can't bypass Caddy.

Reload the systemd configuration and Caddy after creating the environment file and drop-in:

```bash
sudo systemctl daemon-reload
sudo systemctl reload caddy
```

## Connect the server to RetinueOS

Add the server from **Connections** in RetinueOS:

1. Set the URL to `https://workspace-mcp.example.com/mcp`.
2. Select static bearer authentication.
3. Enter the same bearer token configured for Caddy.
4. Discover the tool catalog.
5. Review and approve each tool's risk class.
6. Assign approved tools to the personas that need them.

Keep `start_google_auth` available for initial OAuth authorization. Call it for the service you want to authorize, complete consent in the browser, then retry the original tool call. Repeat this flow if another service requests additional consent.

## Verify the deployment

Check each security and functionality boundary:

```bash
curl --include https://workspace-mcp.example.com/health
curl --include https://workspace-mcp.example.com/mcp
curl --include \
  -H "Authorization: Bearer ${MCP_BEARER_TOKEN}" \
  https://workspace-mcp.example.com/mcp
```

The health request must succeed. The unauthenticated MCP request must return `401`. An authenticated `GET /mcp` may return another `4xx` status, such as `405` or `406`, because MCP operations use `POST` with specific content negotiation. That response confirms the request passed Caddy's bearer check.

Complete Google OAuth, rediscover the catalog, and test one read-only tool from each enabled service. Test write tools only after confirming their RetinueOS risk classes and approval behavior.

## Account for current limitations

The upstream server doesn't expose Google Keep. Google's Keep API targets managed Workspace domains and uses administrator-approved access patterns, so personal Keep accounts don't have equivalent support.

OpenAI strict schemas can't represent arbitrary object keys. RetinueOS converts those objects to closed schemas. Basic tools work, but advanced attachment objects, custom Calendar reminders, and raw Slides batch requests may require a typed compatibility adapter.

The server stores OAuth credentials as files in the credentials volume. Protect host access, back up the volume, and revoke the Google grant if the host or volume is compromised.
