"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClient, type ControlClient, type ControlClientPage, type ControlScope } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { RowSkeleton } from "@/components/ui/skeleton";
import { PAGE_PAD } from "@/lib/touch-layout";

const CONTROL_SCOPES = [
  "personas:read",
  "jobs:read",
  "jobs:write",
  "routines:read",
  "routines:write",
  "approvals:read",
  "approvals:write",
  "audit:read",
] as const satisfies readonly ControlScope[];

const SCOPE_DETAILS = {
  "personas:read": { label: "Read personas", description: "View personas and their details." },
  "jobs:read": { label: "Read jobs", description: "View jobs and their messages." },
  "jobs:write": { label: "Manage jobs", description: "Create, continue, and cancel jobs." },
  "routines:read": { label: "Read routines", description: "View routines and their schedules." },
  "routines:write": { label: "Manage routines", description: "Create, update, run, pause, and delete routines." },
  "approvals:read": { label: "Read approvals", description: "View pending and resolved approvals." },
  "approvals:write": { label: "Resolve approvals", description: "Approve or reject pending approvals." },
  "audit:read": { label: "Read audit", description: "View control-plane audit events." },
} as const satisfies Record<ControlScope, { label: string; description: string }>;

const SCOPE_GROUPS = [
  { label: "Personas", scopes: ["personas:read"] },
  { label: "Jobs", scopes: ["jobs:read", "jobs:write"] },
  { label: "Routines", scopes: ["routines:read", "routines:write"] },
  { label: "Approvals", scopes: ["approvals:read", "approvals:write"] },
  { label: "Audit", scopes: ["audit:read"] },
] as const satisfies readonly { label: string; scopes: readonly ControlScope[] }[];

type LoadState = "loading" | "ready" | "error";

interface ScopeGroup {
  label: string;
  scopes: ControlScope[];
}

// Each response predicate accepts an untrusted JSON value at the HTTP
// boundary, then proves its specific shape before the page renders it.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isControlScope(value: unknown): value is ControlScope {
  return typeof value === "string" && CONTROL_SCOPES.some((scope) => scope === value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function isControlClient(value: unknown): value is ControlClient {
  if (!isRecord(value) || "tokenHash" in value || "token" in value) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.tokenPrefix === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every(isControlScope) &&
    typeof value.createdAt === "string" &&
    (typeof value.lastUsedAt === "string" || value.lastUsedAt === null) &&
    (typeof value.revokedAt === "string" || value.revokedAt === null)
  );
}

/** Checks the exact public cursor-page contract before the settings page
 * renders it. Token hashes and plaintext tokens are intentionally rejected. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function isControlClientPage(value: unknown): value is ControlClientPage {
  if (!isRecord(value) || "tokenHash" in value || "token" in value || !Array.isArray(value.items)) return false;
  return value.items.every(isControlClient) && (typeof value.nextCursor === "string" || value.nextCursor === null);
}

/** Groups a selected set of scopes in the backend's canonical scope order. */
export function groupControlScopes(scopes: readonly ControlScope[]): ScopeGroup[] {
  const selected = new Set(scopes);
  return SCOPE_GROUPS.flatMap((group) => {
    const groupedScopes = group.scopes.filter((scope) => selected.has(scope));
    return groupedScopes.length > 0 ? [{ label: group.label, scopes: groupedScopes }] : [];
  });
}

/** Joins BACKEND_URL / NEXT_PUBLIC_BACKEND_URL onto `/mcp/control` without a
 * double slash. Clients must use this backend origin; the frontend host
 * returns HTML 404 and looks like an invalid MCP server. */
export function controlMcpUrl(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, "")}/mcp/control`;
}

/** A convenience default, not an authorization rule: selecting a write
 * capability initially also selects its matching read capability. The owner
 * can still remove that read scope afterward because backend scopes remain
 * independent and explicit. */
export function pairReadScopesWithWrites(scopes: readonly ControlScope[]): ControlScope[] {
  const paired = new Set(scopes);
  for (const scope of scopes) {
    if (scope === "jobs:write") paired.add("jobs:read");
    if (scope === "routines:write") paired.add("routines:read");
    if (scope === "approvals:write") paired.add("approvals:read");
  }
  return CONTROL_SCOPES.filter((scope) => paired.has(scope));
}

/** A load that began before a successful mutation must not discard the
 * mutation's public row when its stale response finally arrives. Current
 * rows win; the old response only fills in rows it did not know about. */
export function mergeClientsAfterStaleLoad(
  loadedClients: readonly ControlClient[],
  currentClients: readonly ControlClient[],
): ControlClient[] {
  const currentIds = new Set(currentClients.map((controlClient) => controlClient.id));
  return [...currentClients, ...loadedClients.filter((controlClient) => !currentIds.has(controlClient.id))];
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function scopeLabel(scope: ControlScope): string {
  return SCOPE_DETAILS[scope].label;
}

export function AccessSettingsContent() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [clients, setClients] = useState<ControlClient[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ControlScope[]>([]);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [revokeCandidate, setRevokeCandidate] = useState<ControlClient | null>(null);
  const mcpUrl = controlMcpUrl(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080");
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const loadRequestGeneration = useRef(0);
  const mutationGeneration = useRef(0);
  const allScopeGroups = groupControlScopes(CONTROL_SCOPES);

  const load = useCallback(async () => {
    const requestGeneration = ++loadRequestGeneration.current;
    const mutationGenerationAtStart = mutationGeneration.current;
    setLoadState("loading");
    try {
      const allClients: ControlClient[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listControlClients(cursor);
        if (!isControlClientPage(page)) throw new Error("The control-client response had an unexpected shape.");
        allClients.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (requestGeneration !== loadRequestGeneration.current) return;
      setClients((current) =>
        mutationGenerationAtStart === mutationGeneration.current
          ? allClients
          : mergeClientsAfterStaleLoad(allClients, current),
      );
      setLoadState("ready");
    } catch (err) {
      if (requestGeneration !== loadRequestGeneration.current) return;
      if (handleUnauthorized(err, router)) return;
      setLoadState("error");
    }
  }, [client, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  useEffect(() => {
    return () => setCreatedToken(null);
  }, []);

  function toggleScope(scope: ControlScope, checked: boolean) {
    setSelectedScopes((current) => {
      if (!checked) return current.filter((selected) => selected !== scope);
      return scope.endsWith(":write") ? pairReadScopesWithWrites([...current, scope]) : [...current, scope];
    });
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || selectedScopes.length === 0) {
      setFormError("Give this client a name and select at least one scope.");
      return;
    }

    setCreating(true);
    setFormError(null);
    setCopied(false);
    try {
      const created = await client.createControlClient({ name: trimmedName, scopes: selectedScopes });
      mutationGeneration.current += 1;
      setCreatedToken(created.token);
      setClients((current) => [created.client, ...current]);
      setName("");
      setSelectedScopes([]);
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setFormError(err instanceof Error ? err.message : "Couldn't create this client.");
    } finally {
      setCreating(false);
    }
  }

  async function copyCreatedToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function copyMcpUrl() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopiedUrl(true);
    } catch {
      setCopiedUrl(false);
    }
  }

  async function confirmRevoke() {
    if (!revokeCandidate) return;
    setRevokingId(revokeCandidate.id);
    try {
      const revoked = await client.revokeControlClient(revokeCandidate.id);
      mutationGeneration.current += 1;
      setClients((current) => current.map((item) => (item.id === revoked.id ? revoked : item)));
      setRevokeCandidate(null);
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setFormError(err instanceof Error ? err.message : "Couldn't revoke this client.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={`${clients.length} named client${clients.length === 1 ? "" : "s"}`}
        title="Access"
        description="Issue narrowly scoped credentials to trusted control-plane clients and revoke them when access is no longer needed."
      />

      <section className="mb-8 border-t border-border pt-5">
        <h2 className="m-0 font-serif text-xl text-fg">Connect an agent</h2>
        <p className="mb-3 mt-1.5 font-sans text-[13px] leading-relaxed text-fg-muted">
          Desktop and hosted MCP clients talk to this URL — the backend origin, not the app host you are on now.
          Pointing a client at this app origin returns HTML 404 and looks like an invalid MCP server.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            className="max-w-full overflow-x-auto rounded-button border px-3 py-2 font-mono text-xs text-fg"
            style={{ borderColor: "var(--border-strong)", background: "var(--bg)" }}
          >
            {mcpUrl}
          </code>
          <button
            type="button"
            onClick={copyMcpUrl}
            className="min-h-11 rounded-button border px-3 py-2 font-sans text-[13px] font-medium"
            style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
          >
            {copiedUrl ? "Copied" : "Copy URL"}
          </button>
        </div>
        <p className="mb-0 mt-3 font-sans text-[13px] leading-relaxed text-fg-muted">
          Create a token below and send it as an{" "}
          <code className="font-mono text-xs text-fg">Authorization: Bearer</code> header.
        </p>
      </section>

      <section className="mb-8 border-t border-border pt-5">
        <div className="mb-5">
          <h2 className="m-0 font-serif text-xl text-fg">Create a control client</h2>
          <p className="mb-0 mt-1.5 font-sans text-[13px] leading-relaxed text-fg-muted">
            Give a trusted MCP client only the capabilities it needs. The token is shown once after creation.
          </p>
        </div>

        <form onSubmit={handleCreate} className="flex flex-col gap-5">
          <label className="flex max-w-xl flex-col gap-1.5 font-sans text-[13px] font-medium text-fg">
            Client name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Desktop client"
              className="min-h-11 rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
            />
          </label>

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-2 font-sans text-[13px] font-medium text-fg">Capabilities</legend>
            <p className="mb-3 font-sans text-[13px] text-fg-muted">
              Select one or more capabilities for this client. Manage capabilities include their matching read access;
              every selection remains independently enforced by the server.
            </p>
            <div className="grid grid-cols-1 border-y border-border md:grid-cols-2 md:gap-x-8">
              {allScopeGroups.map((group) => (
                <div key={group.label} className="border-b border-border py-3 last:border-b-0">
                  <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-fg-faint">{group.label}</p>
                  <div className="flex flex-col">
                    {group.scopes.map((scope) => (
                      <label
                        key={scope}
                        className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2 font-sans text-[13px] text-fg"
                      >
                        <input
                          type="checkbox"
                          checked={selectedScopes.includes(scope)}
                          onChange={(event) => toggleScope(scope, event.target.checked)}
                          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                        />
                        <span>
                          <span className="block font-medium">{SCOPE_DETAILS[scope].label}</span>
                          <span className="block text-fg-muted">{SCOPE_DETAILS[scope].description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          {formError && <ErrorState title="Couldn't update access" detail={formError} />}

          <div>
            <button
              type="submit"
              disabled={creating}
              className="min-h-11 rounded-button border-0 px-3.5 py-2 font-sans text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              {creating ? "Creating…" : "Create token"}
            </button>
          </div>
        </form>
      </section>

      {createdToken && (
        <section
          className="mb-7 rounded-card border p-5"
          style={{ borderColor: "var(--warning-soft-border)", background: "var(--warning-soft)" }}
        >
          <p className="m-0 font-sans text-sm font-semibold text-fg">Copy this token now</p>
          <p className="mb-3 mt-1.5 font-sans text-[13px] leading-relaxed text-fg-muted">
            RetinueOS will not show this token again. Store it in your client&apos;s secret configuration.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="max-w-full overflow-x-auto rounded-button border px-3 py-2 font-mono text-xs text-fg"
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)" }}
            >
              {createdToken}
            </code>
            <button
              type="button"
              onClick={copyCreatedToken}
              className="min-h-11 rounded-button border px-3 py-2 font-sans text-[13px] font-medium"
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
            >
              {copied ? "Copied" : "Copy token"}
            </button>
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="m-0 font-serif text-xl text-fg">Named clients</h2>
          {loadState === "ready" && (
            <span className="font-mono text-[11px] uppercase tracking-wider text-fg-faint">{clients.length} total</span>
          )}
        </div>

        {loadState === "error" && (
          <ErrorState detail="GET /control/clients failed. Nothing has been changed." onRetry={load} />
        )}

        {loadState === "loading" && (
          <div className="flex flex-col border-y border-border">
            <RowSkeleton />
            <RowSkeleton />
          </div>
        )}

        {loadState === "ready" && clients.length === 0 && (
          <EmptyState
            title="No control clients yet"
            description="Create a named client to connect an MCP control tool."
          />
        )}

        {loadState === "ready" && clients.length > 0 && (
          <div className="flex flex-col gap-3">
            {clients.map((controlClient) => {
              const revoked = controlClient.revokedAt !== null;
              const confirming = revokeCandidate?.id === controlClient.id;
              return (
                <article
                  key={controlClient.id}
                  className="border-b border-border py-4 last:border-b-0"
                  style={{ opacity: revoked ? 0.68 : 1 }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="m-0 font-sans text-sm font-semibold text-fg">{controlClient.name}</h3>
                        <span
                          className="rounded-badge px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                          style={{
                            color: revoked ? "var(--fg-muted)" : "var(--success-soft-fg)",
                            background: revoked ? "var(--neutral-soft)" : "var(--success-soft)",
                          }}
                        >
                          {revoked ? "Revoked" : "Active"}
                        </span>
                      </div>
                      <code className="mt-1 block font-mono text-xs text-fg-faint">
                        retinueos_live_{controlClient.tokenPrefix}_…
                      </code>
                    </div>
                    {!revoked && !confirming && (
                      <button
                        type="button"
                        onClick={() => setRevokeCandidate(controlClient)}
                        className="min-h-11 rounded-button border px-3 font-sans text-[13px] font-medium"
                        style={{
                          borderColor: "var(--danger-soft-border)",
                          background: "var(--surface)",
                          color: "var(--danger-soft-fg)",
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>

                  <dl className="mb-0 mt-4 grid grid-cols-1 gap-3 font-sans text-[13px] text-fg-muted sm:grid-cols-3">
                    <div>
                      <dt className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Created</dt>
                      <dd className="m-0 mt-1 text-fg">{formatDate(controlClient.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Last used</dt>
                      <dd className="m-0 mt-1 text-fg">{formatDate(controlClient.lastUsedAt)}</dd>
                    </div>
                    <div>
                      <dt className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Scopes</dt>
                      <dd className="m-0 mt-1 flex flex-wrap gap-1.5">
                        {controlClient.scopes.map((scope) => (
                          <span
                            key={scope}
                            className="rounded-badge bg-neutral-soft px-2 py-0.5 font-sans text-[11px] text-fg-muted"
                            title={scope}
                          >
                            {scopeLabel(scope)}
                          </span>
                        ))}
                      </dd>
                    </div>
                  </dl>

                  {revoked && (
                    <p className="mb-0 mt-3 font-sans text-[13px] text-fg-muted">
                      Revoked {formatDate(controlClient.revokedAt)}
                    </p>
                  )}

                  {confirming && (
                    <div
                      className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3"
                      style={{ borderColor: "var(--danger-soft-border)" }}
                    >
                      <p className="m-0 flex-1 font-sans text-[13px] text-fg">
                        Revoke this token immediately? Connected clients will lose access.
                      </p>
                      <button
                        type="button"
                        onClick={() => setRevokeCandidate(null)}
                        disabled={revokingId === controlClient.id}
                        className="min-h-11 rounded-button border px-3 font-sans text-[13px] font-medium"
                        style={{
                          borderColor: "var(--border-strong)",
                          background: "var(--surface)",
                          color: "var(--fg-muted)",
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={confirmRevoke}
                        disabled={revokingId === controlClient.id}
                        className="min-h-11 rounded-button border-0 px-3 font-sans text-[13px] font-medium disabled:opacity-60"
                        style={{ background: "var(--danger)", color: "var(--accent-fg)" }}
                      >
                        {revokingId === controlClient.id ? "Revoking…" : "Confirm revoke"}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
