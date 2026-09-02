# ADR 0002: External tools are ToolSpec adapters; remote MCP first

- **Status:** Accepted
- **Date:** 2026-08-22 (tiers); 2026-08-24 (retire hand-coded Gmail/Calendar; OAuth credential type)

## Context

The interrupt gate worked with mocked native tools, but real services such as Gmail and Calendar still needed a secure,
general integration path. Hand-coded service tools plus a separate OAuth script would create a second execution path per
service and too much setup for a normal operator.

## Decision

Every external capability becomes one `ToolSpec` (`origin`, `riskClass`, `run`) and flows through the existing dispatch node and `tool_calls` audit trail. No connector gets its own approval or execution model.

Three tiers, in build-cost order:

1. **MCP (shipped).** Point at a remote HTTPS MCP server, wrap `tools/list` / `tools/call` as `ToolSpec`s. Human-confirmed `riskClass` per tool — never trust the server's `readOnlyHint` / `destructiveHint`. Credentials are server-scoped: static bearer **or** OAuth authorization-code (refresh + short-lived access token). Private, loopback, and non-HTTPS URLs are rejected; request-time DNS is pinned against rebinding.
2. **Custom scripts (not started).** Persona- or operator-authored code, sandboxed, existence approval separate from invocation approval.
3. **Browser agents (not started).** Narrow primitives (`navigate`, bounded extract, later a constrained click), user-origin jobs only, DOM treated as untrusted input.

Hand-coded Gmail and Calendar tools were retired once Tier 1 existed rather than kept "because they already worked." Nothing was using them, the setup path was worse than MCP OAuth, and two paths for the same capability would have to be maintained forever. Operators connect Gmail/Calendar (or anything else) from **Settings → Connections**; see [CONNECTORS.md](../CONNECTORS.md).

Local stdio MCP servers are an explicit non-goal for v1: a local server is an arbitrary subprocess on the host.

## Consequences

- Adding Slack, Linear, Drive, etc. is configuration plus a human risk confirmation, not a new backend integration.
- `ToolOrigin` (`native` | `mcp` | `custom_script` | `browser_agent`) is metadata on the same `ToolSpec` shape. Tiers 2 and 3 still have nowhere that _produces_ those origins.
- Generic per-toolId `credentials` remains for future non-MCP secrets; MCP secrets live on `mcp_servers`.
- A curated in-app catalog, custom-script sandbox, browser agents, and local stdio are future work, not implicit in this ADR.
