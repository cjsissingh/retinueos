"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiClient, type CustomToolProposal, type RiskClass } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { RiskBadge } from "@/components/risk-frame";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { TechnicalDetails } from "@/components/technical-details";
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

/** toolKey becomes the eventual ToolSpec.id — mirrors the backend's
 *  custom-tool-schemas.ts regex exactly so a value rejected here would also
 *  be rejected server-side, and vice versa. */
export function isValidToolKey(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,62}$/.test(value);
}

/** Comma-separated free text (host allow-list, secret ref names) → a
 *  trimmed, non-empty string array. */
export function parseListInput(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function customScriptDisplayName(toolKey: string): string {
  return displayToolName(toolKey);
}

/**
 * Operator-facing custom-script proposal and review UI (custom-script sandbox / Tier 2).
 * Existence approval only: nothing here executes a script.
 */
export function CustomScriptsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );

  const [tools, setTools] = useState<CustomToolProposal[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<CustomToolProposal[]>([]);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  const [toolKey, setToolKey] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [parametersSchemaText, setParametersSchemaText] = useState("{}");
  const [hostAllowListText, setHostAllowListText] = useState("");
  const [secretRefsText, setSecretRefsText] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(5_000);
  const [memoryMb, setMemoryMb] = useState(128);
  const [maxOutputBytes, setMaxOutputBytes] = useState(65_536);
  const [suggestedRiskClass, setSuggestedRiskClass] = useState<RiskClass>("reversible");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const formOpen = searchParams.get("new") === "1" || editingKey !== null;

  const loadTools = useCallback(async () => {
    setLoadState("loading");
    try {
      setTools(await client.listCustomTools());
      setLoadState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setLoadState("error");
    }
  }, [client, router]);

  const loadVersions = useCallback(
    async (key: string) => {
      setVersions([]);
      setVersionsError(null);
      try {
        setVersions(await client.listCustomToolVersions(key));
      } catch (err) {
        if (handleUnauthorized(err, router)) return;
        setVersionsError("Couldn't load this script's version history.");
      }
    },
    [client, router],
  );

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    loadTools();
  }, [loadTools, router]);

  useEffect(() => {
    if (selectedKey) loadVersions(selectedKey);
  }, [selectedKey, loadVersions]);

  function resetForm() {
    setToolKey("");
    setDescription("");
    setSource("");
    setParametersSchemaText("{}");
    setHostAllowListText("");
    setSecretRefsText("");
    setTimeoutMs(5_000);
    setMemoryMb(128);
    setMaxOutputBytes(65_536);
    setSuggestedRiskClass("reversible");
    setEditingKey(null);
  }

  function startEdit(key: string, latest: CustomToolProposal) {
    setEditingKey(key);
    setToolKey(key);
    setDescription(latest.description);
    setSource(latest.source);
    setParametersSchemaText(JSON.stringify(latest.parametersSchema, null, 2));
    setHostAllowListText(latest.hostAllowList.join(", "));
    setSecretRefsText(latest.secretRefs.join(", "));
    setTimeoutMs(latest.limits.timeoutMs);
    setMemoryMb(latest.limits.memoryMb);
    setMaxOutputBytes(latest.limits.maxOutputBytes);
    setSuggestedRiskClass(latest.suggestedRiskClass);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    let parametersSchema: Record<string, unknown>;
    try {
      // SAFETY: the parameters textarea is meant to hold a JSON *object*
      // (a JSON Schema); JSON.parse can technically return any JSON value,
      // but a non-object here is a user-authoring mistake caught by the
      // backend's own schema validation on submit, not a type-safety gap.
      parametersSchema = JSON.parse(parametersSchemaText) as Record<string, unknown>;
    } catch {
      setFormError("Parameters schema must be valid JSON.");
      setSubmitting(false);
      return;
    }
    const input = {
      description,
      source,
      parametersSchema,
      hostAllowList: parseListInput(hostAllowListText),
      secretRefs: parseListInput(secretRefsText),
      limits: { timeoutMs, memoryMb, maxOutputBytes },
      suggestedRiskClass,
    };
    try {
      if (editingKey) {
        await client.createCustomToolVersion(editingKey, input);
      } else {
        if (!isValidToolKey(toolKey)) {
          setFormError(
            "Tool key must start with a lowercase letter and contain only lowercase letters, digits, - or _.",
          );
          setSubmitting(false);
          return;
        }
        await client.createCustomTool({ ...input, toolKey });
      }
      const wasEditing = editingKey;
      resetForm();
      await loadTools();
      if (wasEditing && selectedKey === wasEditing) await loadVersions(wasEditing);
      router.push("/settings/custom-scripts");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setFormError(err instanceof Error ? err.message : "Couldn't save that proposal.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReview(key: string, version: number, status: "approved" | "rejected") {
    try {
      await client.reviewCustomToolVersion(key, version, { status });
      await Promise.all([loadTools(), loadVersions(key)]);
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setVersionsError("Couldn't record that review decision.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader
        eyebrow="Settings"
        title={
          editingKey
            ? `New version of ${customScriptDisplayName(editingKey)}`
            : formOpen
              ? "Propose a script"
              : "Custom Scripts"
        }
        description={
          formOpen
            ? "Define a sandboxed capability for review before it becomes available to the house."
            : "Review and version locally authored capabilities without exposing implementation detail by default."
        }
        backHref={formOpen ? "/settings/custom-scripts" : undefined}
        actions={
          !formOpen ? (
            <Link
              href="/settings/custom-scripts?new=1"
              className={SECONDARY_BUTTON}
              style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
            >
              Propose script
            </Link>
          ) : undefined
        }
      />

      <form hidden={!formOpen} onSubmit={handleSubmit} className="mb-8 flex max-w-2xl flex-col gap-5">
        <p className="m-0 font-sans text-sm font-semibold text-fg">
          {editingKey ? `New version of ${customScriptDisplayName(editingKey)}` : "Script definition"}
        </p>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Tool key
          <input
            className={inputClass}
            style={inputStyle}
            placeholder="e.g. weather-scraper"
            value={toolKey}
            onChange={(e) => setToolKey(e.target.value)}
            disabled={Boolean(editingKey)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Description
          <input
            className={inputClass}
            style={inputStyle}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Source
          <textarea
            className={`${inputClass} min-h-40 font-mono`}
            style={inputStyle}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Parameters JSON Schema
          <textarea
            className={`${inputClass} min-h-24 font-mono`}
            style={inputStyle}
            value={parametersSchemaText}
            onChange={(e) => setParametersSchemaText(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Host allow-list (comma-separated)
          <input
            className={inputClass}
            style={inputStyle}
            value={hostAllowListText}
            onChange={(e) => setHostAllowListText(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Secret ref names (comma-separated, never a raw secret value)
          <input
            className={inputClass}
            style={inputStyle}
            value={secretRefsText}
            onChange={(e) => setSecretRefsText(e.target.value)}
          />
        </label>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
            Timeout (ms)
            <input
              type="number"
              className={inputClass}
              style={inputStyle}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              min={1}
              required
            />
          </label>
          <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
            Memory (MB)
            <input
              type="number"
              className={inputClass}
              style={inputStyle}
              value={memoryMb}
              onChange={(e) => setMemoryMb(Number(e.target.value))}
              min={1}
              required
            />
          </label>
          <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
            Max output (bytes)
            <input
              type="number"
              className={inputClass}
              style={inputStyle}
              value={maxOutputBytes}
              onChange={(e) => setMaxOutputBytes(Number(e.target.value))}
              min={1}
              required
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 font-sans text-xs text-fg-muted">
          Suggested risk class
          <select
            value={suggestedRiskClass}
            // SAFETY: value is constrained to the <option>s below, which only emit RISK_OPTIONS' `id`s (RiskClass).
            onChange={(e) => setSuggestedRiskClass(e.target.value as RiskClass)}
            className="min-h-11 rounded-button border px-2 font-sans text-[12px] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
          >
            {RISK_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {formError && (
          <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
            {formError}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={submitting}
            className="min-h-11 w-fit rounded-button border-0 px-4 py-2 font-sans text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            {submitting ? "Saving…" : editingKey ? "Submit new version" : "Propose script"}
          </button>
          {editingKey && (
            <button
              type="button"
              onClick={() => {
                resetForm();
                router.push("/settings/custom-scripts");
              }}
              className="min-h-11 w-fit rounded-button border px-4 py-2 font-sans text-sm"
              style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {!formOpen && loadState === "loading" && <p className="font-sans text-sm text-fg-muted">Loading…</p>}
      {!formOpen && loadState === "error" && <ErrorState onRetry={loadTools} />}
      {!formOpen && loadState === "ready" && tools.length === 0 && (
        <EmptyState
          title="No custom scripts yet"
          description="Propose a script when the house needs a new capability."
        />
      )}

      {!formOpen && loadState === "ready" && tools.length > 0 && (
        <div className="flex flex-col border-y border-border">
          {tools.map((latest) => (
            <div key={latest.toolKey} className="border-b border-border py-4 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedKey(selectedKey === latest.toolKey ? null : latest.toolKey)}
                  className="font-sans text-sm font-semibold text-fg underline-offset-2 hover:underline"
                >
                  <span className="block text-left">{customScriptDisplayName(latest.toolKey)}</span>
                  <code className="block font-mono text-[10px] font-normal text-fg-faint">{latest.toolKey}</code>
                </button>
                <div className="flex items-center gap-2">
                  <RiskBadge riskClass={latest.suggestedRiskClass} />
                  <span className="font-mono text-[11px] text-fg-faint">v{latest.version}</span>
                  <button
                    type="button"
                    onClick={() => startEdit(latest.toolKey, latest)}
                    className="min-h-11 rounded-button border px-3 font-sans text-[12px]"
                    style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                  >
                    New version
                  </button>
                </div>
              </div>
              <p className="m-0 mt-1 font-sans text-[12px] text-fg-muted">{latest.description}</p>

              {selectedKey === latest.toolKey && (
                <div className="mt-3 flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
                  {versionsError && <ErrorState detail={versionsError} />}
                  {versions.map((version) => (
                    <div key={version.version} className="border-b border-border py-3 last:border-b-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-[12px] text-fg">v{version.version}</span>
                        <span className="font-sans text-[11px] text-fg-faint">{displayEnum(version.status)}</span>
                      </div>
                      <TechnicalDetails label="Source and limits">
                        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-button bg-surface-sunken p-3 font-mono text-[11px] text-fg-muted">
                          {version.source}
                        </pre>
                        <p className="m-0 mt-2 font-mono text-[10px] text-fg-faint">
                          hosts: {version.hostAllowList.join(", ") || "none"} · secrets:{" "}
                          {version.secretRefs.join(", ") || "none"} · limits: {version.limits.timeoutMs}ms /{" "}
                          {version.limits.memoryMb}MB / {version.limits.maxOutputBytes}B
                        </p>
                      </TechnicalDetails>
                      {version.status === "pending" && (
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleReview(latest.toolKey, version.version, "approved")}
                            className="min-h-11 rounded-button border-0 px-3 font-sans text-[12px] font-medium"
                            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReview(latest.toolKey, version.version, "rejected")}
                            className="min-h-11 rounded-button border px-3 font-sans text-[12px]"
                            style={{ borderColor: "var(--danger-soft-border)", color: "var(--danger-soft-fg)" }}
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
