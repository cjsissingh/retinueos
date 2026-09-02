"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ApiClient, type McpServer, type McpServerTool, type RiskClass } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { RiskBadge } from "@/components/risk-frame";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { displayEnum, displayToolName } from "@/lib/display";
import { SECONDARY_BUTTON } from "@/lib/touch-layout";

const inputClass =
  "w-full min-h-11 rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

const RISK_OPTIONS: Array<{ id: RiskClass; label: string }> = [
  { id: "read_only", label: "Read only" },
  { id: "reversible", label: "Reversible" },
  { id: "destructive", label: "Destructive" },
];

export const GOOGLE_OAUTH_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_GMAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

/** Infers which Google OAuth scope the "Use Google preset" button should
 *  fill in, from whichever MCP server URL is already typed into the form —
 *  Google hosts Gmail and Calendar as separate MCP servers
 *  (gmailmcp.googleapis.com / calendarmcp.googleapis.com) with the same
 *  OAuth endpoints but different scopes. Returns "" for anything else, so
 *  the user fills the scope in by hand. */
export function inferGoogleOAuthScope(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  if (parsed.hostname === "gmailmcp.googleapis.com") return GOOGLE_GMAIL_SCOPE;
  if (parsed.hostname === "calendarmcp.googleapis.com") return GOOGLE_CALENDAR_SCOPE;
  return "";
}

type McpServerAuthState = Pick<McpServer, "authType" | "oauthConnected">;

export function oauthConnectLabel(server: McpServerAuthState): "Connect" | "Reconnect" | null {
  if (server.authType !== "oauth") return null;
  return server.oauthConnected ? "Reconnect" : "Connect";
}

export function canRediscoverMcpServer(server: McpServerAuthState): boolean {
  return server.authType !== "oauth" || server.oauthConnected;
}

interface McpToolPartitions {
  needsReview: McpServerTool[];
  approved: McpServerTool[];
}

interface McpToolMerge {
  servers: McpServer[];
  tools: McpServerTool[];
}

export function partitionMcpTools(tools: McpServerTool[]): McpToolPartitions {
  return {
    needsReview: tools.filter((tool) => !tool.approved),
    approved: tools.filter((tool) => tool.approved),
  };
}

export function mergeMcpToolUpdates(
  servers: McpServer[],
  tools: McpServerTool[],
  updates: McpServerTool[],
): McpToolMerge {
  const previousById = new Map(tools.map((tool) => [tool.id, tool]));
  const updatesById = new Map(updates.map((tool) => [tool.id, tool]));
  const countDeltaByServer = new Map<string, number>();

  for (const update of updates) {
    const previous = previousById.get(update.id);
    if (!previous || previous.approved === update.approved) continue;
    const delta = update.approved ? 1 : -1;
    countDeltaByServer.set(update.serverId, (countDeltaByServer.get(update.serverId) ?? 0) + delta);
  }

  return {
    tools: tools.map((tool) => updatesById.get(tool.id) ?? tool),
    servers: servers.map((server) => ({
      ...server,
      approvedCount: Math.max(0, server.approvedCount + (countDeltaByServer.get(server.id) ?? 0)),
    })),
  };
}

/**
 * Minimal MCP admin surface — see docs/adr/0002-external-tools-via-mcp-adapters.md.
 * Add a remote HTTPS MCP server, see what it reports, and approve individual
 * tools with a human-picked risk class before they become callable anywhere
 * else in the app. Wiring approved tool ids into persona tool-assignment is
 * handled by persona-form.tsx (personaToolOptions/listAvailableMcpTools).
 */
export function McpSettingsContent() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );

  const [servers, setServers] = useState<McpServer[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tools, setTools] = useState<McpServerTool[]>([]);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(() => new Set());
  const [bulkRisk, setBulkRisk] = useState<RiskClass>("reversible");
  const [bulkBusy, setBulkBusy] = useState(false);
  const toolPartitions = partitionMcpTools(tools);
  const allNeedsReviewSelected =
    toolPartitions.needsReview.length > 0 && toolPartitions.needsReview.every((tool) => selectedToolIds.has(tool.id));

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const [authTypeMode, setAuthTypeMode] = useState<"bearer" | "oauth">("bearer");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthAuthorizationEndpoint, setOauthAuthorizationEndpoint] = useState("");
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState("");
  const [oauthScope, setOauthScope] = useState("");
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const adding = searchParams.get("new") === "1";

  const loadServers = useCallback(async () => {
    setLoadState("loading");
    try {
      const list = await client.listMcpServers();
      setServers(list);
      setLoadState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setLoadState("error");
    }
  }, [client, router]);

  const loadTools = useCallback(
    async (serverId: string) => {
      setToolsError(null);
      try {
        setTools(await client.listMcpServerTools(serverId));
      } catch (err) {
        if (handleUnauthorized(err, router)) return;
        setToolsError("Couldn't load this server's tools.");
      }
    },
    [client, router],
  );

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    loadServers();
  }, [loadServers, router]);

  useEffect(() => {
    setSelectedToolIds(new Set());
    if (selectedId) loadTools(selectedId);
  }, [selectedId, loadTools]);

  useEffect(() => {
    const connected = searchParams.get("connected");
    const oauthError = searchParams.get("oauth_error");
    if (connected) {
      setConnectNotice("Connected — tool catalog refreshed.");
      setSelectedId(connected);
      loadServers();
    } else if (oauthError) {
      setConnectNotice(`OAuth connection failed: ${oauthError}`);
    }
    // Deliberately runs once — searchParams/loadServers changing after
    // mount (e.g. from user interaction) shouldn't re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleUseGooglePreset() {
    setOauthAuthorizationEndpoint(GOOGLE_OAUTH_AUTHORIZATION_ENDPOINT);
    setOauthTokenEndpoint(GOOGLE_OAUTH_TOKEN_ENDPOINT);
    setOauthScope(inferGoogleOAuthScope(url));
  }

  async function handleAddServer(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFormNotice(null);
    try {
      const result =
        authTypeMode === "oauth"
          ? await client.createMcpServer({
              authType: "oauth",
              name,
              url,
              oauthClientId,
              oauthClientSecret,
              oauthAuthorizationEndpoint,
              oauthTokenEndpoint,
              oauthScope,
            })
          : await client.createMcpServer({ name, url, bearerToken: bearerToken || undefined });
      setName("");
      setUrl("");
      setBearerToken("");
      setOauthClientId("");
      setOauthClientSecret("");
      setOauthAuthorizationEndpoint("");
      setOauthTokenEndpoint("");
      setOauthScope("");
      setFormNotice(
        result.discovery.ok
          ? `Connected — discovered ${result.discovery.toolCount} tool(s).`
          : result.discovery.errorCategory === "not_connected"
            ? "Server added — click Connect below to finish OAuth setup."
            : `Server added, but discovery failed: ${result.discovery.error}. Retry from the server list below.`,
      );
      await loadServers();
      setSelectedId(result.server.id);
      router.push("/settings/mcp");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setFormError(err instanceof Error ? err.message : "Couldn't add that server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConnect(serverId: string) {
    try {
      const { authorizeUrl } = await client.startMcpServerOAuth(serverId);
      window.location.href = authorizeUrl;
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setToolsError("Couldn't start the OAuth handshake for this server.");
    }
  }

  async function handleRediscover(serverId: string) {
    try {
      await client.discoverMcpServerTools(serverId);
      await Promise.all([loadServers(), loadTools(serverId)]);
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setToolsError("Discovery failed — the server may be unreachable.");
    }
  }

  async function handleDeleteServer(serverId: string) {
    try {
      await client.deleteMcpServer(serverId);
      if (selectedId === serverId) {
        setSelectedId(null);
        setTools([]);
      }
      await loadServers();
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
    }
  }

  async function handleToggleServer(server: McpServer) {
    try {
      await client.updateMcpServer(server.id, { enabled: !server.enabled });
      await loadServers();
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
    }
  }

  async function handleApprove(tool: McpServerTool, riskClass: RiskClass) {
    if (!selectedId) return;
    try {
      const updated = await client.updateMcpServerTool(selectedId, tool.id, { riskClass, approved: true });
      setTools((current) => mergeMcpToolUpdates([], current, [updated]).tools);
      setServers((current) => mergeMcpToolUpdates(current, tools, [updated]).servers);
      setSelectedToolIds((prev) => {
        const next = new Set(prev);
        next.delete(updated.id);
        return next;
      });
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
    }
  }

  async function handleRevoke(tool: McpServerTool) {
    if (!selectedId) return;
    try {
      const updated = await client.updateMcpServerTool(selectedId, tool.id, { approved: false });
      setTools((current) => mergeMcpToolUpdates([], current, [updated]).tools);
      setServers((current) => mergeMcpToolUpdates(current, tools, [updated]).servers);
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
    }
  }

  function toggleToolSelection(toolId: string) {
    setSelectedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }

  function handleBulkRiskChange(value: string) {
    const option = RISK_OPTIONS.find((candidate) => candidate.id === value);
    if (option) setBulkRisk(option.id);
  }

  async function handleBulkApprove() {
    if (!selectedId || selectedToolIds.size === 0) return;
    setBulkBusy(true);
    setToolsError(null);
    const selected = tools.filter((tool) => !tool.approved && selectedToolIds.has(tool.id));
    const results = await Promise.allSettled(
      selected.map((tool) => client.updateMcpServerTool(selectedId, tool.id, { riskClass: bulkRisk, approved: true })),
    );
    const approved = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (approved.length > 0) {
      setTools((current) => mergeMcpToolUpdates([], current, approved).tools);
      setServers((current) => mergeMcpToolUpdates(current, tools, approved).servers);
      setSelectedToolIds((prev) => {
        const next = new Set(prev);
        for (const tool of approved) next.delete(tool.id);
        return next;
      });
    }
    if (approved.length !== selected.length)
      setToolsError("Some tools couldn't be approved. The successful approvals were kept.");
    setBulkBusy(false);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        eyebrow="Settings"
        title={adding ? "Add MCP connection" : "MCP Connections"}
        description={
          adding
            ? "Connect a remote HTTPS server, then review its capabilities before anyone can use them."
            : "Manage external capability providers and review every tool before it enters the house."
        }
        backHref={adding ? "/settings/mcp" : undefined}
        actions={
          !adding ? (
            <Link
              href="/settings/mcp?new=1"
              className={SECONDARY_BUTTON}
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
            >
              Add connection
            </Link>
          ) : undefined
        }
      />

      {connectNotice && (
        <p className="mb-4 font-sans text-[13px]" style={{ color: "var(--fg-muted)" }}>
          {connectNotice}
        </p>
      )}

      <form
        hidden={!adding}
        onSubmit={handleAddServer}
        className="mb-8 flex flex-col gap-3 rounded-button border p-4"
        style={{ borderColor: "var(--border)" }}
      >
        <p className="m-0 font-sans text-sm font-semibold text-fg">Add a remote MCP server</p>
        <div className="flex gap-2 font-sans text-xs">
          <button
            type="button"
            onClick={() => setAuthTypeMode("bearer")}
            aria-pressed={authTypeMode === "bearer"}
            className="min-h-11 rounded-button border px-3"
            style={{
              borderColor: "var(--border-strong)",
              background: authTypeMode === "bearer" ? "var(--accent)" : "transparent",
              color: authTypeMode === "bearer" ? "var(--accent-fg)" : "var(--fg-muted)",
            }}
          >
            Static token
          </button>
          <button
            type="button"
            onClick={() => setAuthTypeMode("oauth")}
            aria-pressed={authTypeMode === "oauth"}
            className="min-h-11 rounded-button border px-3"
            style={{
              borderColor: "var(--border-strong)",
              background: authTypeMode === "oauth" ? "var(--accent)" : "transparent",
              color: authTypeMode === "oauth" ? "var(--accent-fg)" : "var(--fg-muted)",
            }}
          >
            OAuth
          </button>
        </div>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Name
          <input
            className={inputClass}
            style={inputStyle}
            placeholder="e.g. Notion"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Streamable HTTP endpoint
          <input
            className={inputClass}
            style={inputStyle}
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
          />
        </label>
        {authTypeMode === "bearer" ? (
          <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
            Bearer token (optional)
            <input
              className={inputClass}
              style={inputStyle}
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              type="password"
            />
          </label>
        ) : (
          <>
            <button
              type="button"
              onClick={handleUseGooglePreset}
              className="min-h-11 w-fit rounded-button border px-3 font-sans text-[12px]"
              style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
            >
              Use Google preset
            </button>
            <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
              Client ID
              <input
                className={inputClass}
                style={inputStyle}
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                required
              />
            </label>
            <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
              Client secret
              <input
                className={inputClass}
                style={inputStyle}
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                type="password"
                required
              />
            </label>
            <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
              Authorization endpoint
              <input
                className={inputClass}
                style={inputStyle}
                value={oauthAuthorizationEndpoint}
                onChange={(e) => setOauthAuthorizationEndpoint(e.target.value)}
                type="url"
                required
              />
            </label>
            <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
              Token endpoint
              <input
                className={inputClass}
                style={inputStyle}
                value={oauthTokenEndpoint}
                onChange={(e) => setOauthTokenEndpoint(e.target.value)}
                type="url"
                required
              />
            </label>
            <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
              Scope
              <input
                className={inputClass}
                style={inputStyle}
                value={oauthScope}
                onChange={(e) => setOauthScope(e.target.value)}
                required
              />
            </label>
          </>
        )}
        {formError && (
          <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
            {formError}
          </p>
        )}
        {formNotice && (
          <p className="m-0 font-sans text-[13px]" style={{ color: "var(--fg-muted)" }}>
            {formNotice}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="min-h-11 w-fit rounded-button border-0 px-4 py-2 font-sans text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {submitting ? "Adding…" : "Add server"}
        </button>
      </form>

      {!adding && loadState === "loading" && <p className="font-sans text-sm text-fg-muted">Loading…</p>}
      {!adding && loadState === "error" && <ErrorState onRetry={loadServers} />}
      {!adding && loadState === "ready" && servers.length === 0 && (
        <EmptyState title="No MCP connections yet" description="Add a connection to discover its capabilities." />
      )}

      {!adding && loadState === "ready" && servers.length > 0 && (
        <div className="flex flex-col border-y border-border">
          {servers.map((server) => (
            <div key={server.id} className="border-b border-border py-4 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedId(selectedId === server.id ? null : server.id)}
                  className="font-sans text-sm font-semibold text-fg underline-offset-2 hover:underline"
                >
                  {server.name}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleToggleServer(server)}
                    className="min-h-11 rounded-button border px-3 font-sans text-[12px]"
                    style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                  >
                    {server.enabled ? "Disable" : "Enable"}
                  </button>
                  <span className="font-mono text-[11px] text-fg-faint">
                    {server.approvedCount}/{server.toolCount} approved
                  </span>
                  {oauthConnectLabel(server) && (
                    <button
                      type="button"
                      onClick={() => handleConnect(server.id)}
                      className="min-h-11 rounded-button border-0 px-3 font-sans text-[12px] font-medium"
                      style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                    >
                      {oauthConnectLabel(server)}
                    </button>
                  )}
                  {canRediscoverMcpServer(server) && (
                    <button
                      type="button"
                      onClick={() => handleRediscover(server.id)}
                      className="min-h-11 rounded-button border px-3 font-sans text-[12px]"
                      style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                    >
                      Re-discover
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDeleteServer(server.id)}
                    className="min-h-11 rounded-button border px-3 font-sans text-[12px]"
                    style={{ borderColor: "var(--danger-soft-border)", color: "var(--danger-soft-fg)" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <p className="m-0 mt-1 font-mono text-[11px] text-fg-faint">{server.url}</p>

              {selectedId === server.id && (
                <div className="mt-3 flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                  {toolsError && <ErrorState detail={toolsError} />}
                  {tools.length === 0 && !toolsError && (
                    <p className="m-0 font-sans text-[13px] text-fg-muted">No tools discovered yet.</p>
                  )}
                  {tools.length > 0 && (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h3 className="m-0 text-pretty font-sans text-sm font-semibold text-fg">Needs Review</h3>
                          <p className="m-0 font-mono text-[10px] text-fg-faint">
                            {toolPartitions.needsReview.length} tool
                            {toolPartitions.needsReview.length === 1 ? "" : "s"}
                          </p>
                        </div>
                        {toolPartitions.needsReview.length > 0 && (
                          <div
                            className="flex flex-wrap items-center gap-2 rounded-button border p-2"
                            style={{ borderColor: "var(--border)" }}
                          >
                            <label className="flex min-h-11 items-center gap-1.5 font-sans text-[12px] text-fg-muted">
                              <input
                                type="checkbox"
                                checked={allNeedsReviewSelected}
                                onChange={() =>
                                  setSelectedToolIds(
                                    allNeedsReviewSelected
                                      ? new Set()
                                      : new Set(toolPartitions.needsReview.map((tool) => tool.id)),
                                  )
                                }
                              />
                              Select all
                            </label>
                            <select
                              aria-label="Risk class for selected tools"
                              value={bulkRisk}
                              onChange={(event) => handleBulkRiskChange(event.target.value)}
                              className="min-h-11 rounded-button border px-2 font-sans text-[12px] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                              style={{
                                borderColor: "var(--border-strong)",
                                background: "var(--surface)",
                                color: "var(--fg)",
                              }}
                            >
                              {RISK_OPTIONS.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={selectedToolIds.size === 0 || bulkBusy}
                              onClick={handleBulkApprove}
                              aria-live="polite"
                              className="min-h-11 rounded-button border-0 px-3 font-sans text-[12px] font-medium hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
                              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                            >
                              {bulkBusy ? "Approving…" : `Approve selected (${selectedToolIds.size})`}
                            </button>
                          </div>
                        )}
                      </div>
                      {toolPartitions.needsReview.length === 0 && (
                        <p className="m-0 font-sans text-[13px] text-fg-muted">
                          Everything discovered here is approved.
                        </p>
                      )}
                      {toolPartitions.needsReview.map((tool) => (
                        <McpToolRow
                          key={tool.id}
                          tool={tool}
                          selected={selectedToolIds.has(tool.id)}
                          onToggleSelected={() => toggleToolSelection(tool.id)}
                          onApprove={handleApprove}
                          onRevoke={handleRevoke}
                        />
                      ))}
                      {toolPartitions.approved.length > 0 && (
                        <h3
                          className="mb-0 mt-3 border-t pt-3 font-sans text-sm font-semibold text-fg"
                          style={{ borderColor: "var(--border)" }}
                        >
                          Approved{" "}
                          <span className="font-mono text-[10px] font-normal text-fg-faint">
                            ({toolPartitions.approved.length})
                          </span>
                        </h3>
                      )}
                      {toolPartitions.approved.map((tool) => (
                        <McpToolRow key={tool.id} tool={tool} onApprove={handleApprove} onRevoke={handleRevoke} />
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function McpToolRow({
  tool,
  onApprove,
  onRevoke,
  selected = false,
  onToggleSelected,
}: {
  tool: McpServerTool;
  onApprove: (tool: McpServerTool, riskClass: RiskClass) => Promise<void>;
  onRevoke: (tool: McpServerTool) => Promise<void>;
  selected?: boolean;
  onToggleSelected?: () => void;
}) {
  const [pickedRisk, setPickedRisk] = useState<RiskClass>(tool.riskClass ?? tool.serverHintRiskClass ?? "reversible");
  const [busy, setBusy] = useState(false);
  const displayName = displayToolName(tool.toolName);

  function handleRiskChange(value: string) {
    const option = RISK_OPTIONS.find((candidate) => candidate.id === value);
    if (option) setPickedRisk(option.id);
  }

  async function handleAction(action: () => Promise<void>) {
    setBusy(true);
    await action();
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 [content-visibility:auto] [contain-intrinsic-size:auto_72px] last:border-b-0">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {!tool.approved && onToggleSelected && (
          <label className="grid min-h-11 min-w-11 flex-none place-items-center" aria-label={`Select ${displayName}`}>
            <input type="checkbox" checked={selected} onChange={onToggleSelected} />
          </label>
        )}
        <div className="min-w-0">
          <p className="m-0 font-sans text-sm font-medium text-fg">{displayName}</p>
          <code className="block truncate font-mono text-[10px] text-fg-faint">{tool.toolName}</code>
          <p className="m-0 mt-1 line-clamp-2 break-words font-sans text-[12px] leading-relaxed text-fg-muted">
            {tool.description}
          </p>
          <p className="m-0 mt-1 font-sans text-[11px] text-fg-faint">
            Server suggestion · {tool.serverHintRiskClass ? displayEnum(tool.serverHintRiskClass) : "Unspecified"} ·
            unverified
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {tool.approved && tool.riskClass ? (
          <>
            <RiskBadge riskClass={tool.riskClass} />
            <button
              type="button"
              disabled={busy}
              onClick={() => handleAction(() => onRevoke(tool))}
              className="min-h-11 rounded-button border px-3 font-sans text-[12px] hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
              style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
            >
              Revoke
            </button>
          </>
        ) : (
          <>
            <select
              aria-label={`Risk class for ${tool.toolName}`}
              value={pickedRisk}
              onChange={(e) => handleRiskChange(e.target.value)}
              disabled={busy}
              className="min-h-11 rounded-button border px-2 font-sans text-[12px] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
            >
              {RISK_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleAction(() => onApprove(tool, pickedRisk))}
              className="min-h-11 rounded-button border-0 px-3 font-sans text-[12px] font-medium hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              {busy ? "Approving…" : "Approve"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
