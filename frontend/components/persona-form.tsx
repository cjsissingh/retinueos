"use client";

import { useEffect, useId, useState } from "react";
import {
  ApiClient,
  ApiError,
  type AssignedToolConfig,
  type AvailableMcpTool,
  type Persona,
  type RiskClass,
} from "@/lib/api-client";
import { useModelCatalog } from "@/lib/use-model-catalog";
import { buildPersonaFormValues, type PersonaFormValues } from "@/lib/persona-form-values";
import { ToolPermissionsEditor } from "@/components/tool-permissions";
import { displayModelName } from "@/lib/display";

const ALL_PROVIDERS = ["anthropic", "openai"];

export interface PersonaToolOption {
  id: string;
  label: string;
  sourceName: string;
  riskClass: RiskClass;
  groupKey?: string;
  unavailable?: boolean;
}

const NATIVE_TOOL_OPTIONS: PersonaToolOption[] = [
  { id: "get_weather", label: "Get Weather", sourceName: "Built-in", riskClass: "read_only" },
  { id: "send_email", label: "Send Email", sourceName: "Built-in", riskClass: "destructive" },
  { id: "delegate_to", label: "Delegate To", sourceName: "Built-in", riskClass: "reversible" },
  { id: "read_state", label: "Read own notes/state", sourceName: "Built-in", riskClass: "read_only" },
  { id: "write_state", label: "Write own notes/state", sourceName: "Built-in", riskClass: "reversible" },
  { id: "list_state", label: "List own notes/state keys", sourceName: "Built-in", riskClass: "read_only" },
  { id: "forget_state", label: "Delete own notes/state", sourceName: "Built-in", riskClass: "reversible" },
  { id: "remember", label: "Remember a fact", sourceName: "Built-in", riskClass: "reversible" },
  { id: "recall", label: "Recall remembered facts", sourceName: "Built-in", riskClass: "read_only" },
  { id: "forget_memory", label: "Forget a remembered fact", sourceName: "Built-in", riskClass: "reversible" },
  {
    id: "promote_memory",
    label: "Promote a fact to manager's memory",
    sourceName: "Built-in",
    riskClass: "reversible",
  },
];

const WEB_SEARCH_TOOL_OPTION: PersonaToolOption = {
  id: "web_search",
  label: "Search the web",
  sourceName: "Built-in",
  riskClass: "read_only",
};

const ROUTINE_TOOL_OPTIONS: PersonaToolOption[] = [
  {
    id: "list_own_routines",
    label: "List own routines",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "read_only",
  },
  {
    id: "create_own_routine",
    label: "Create own routine",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "reversible",
  },
  {
    id: "update_own_routine",
    label: "Update own routine",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "reversible",
  },
  {
    id: "pause_own_routine",
    label: "Pause own routine",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "reversible",
  },
  {
    id: "resume_own_routine",
    label: "Resume own routine",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "reversible",
  },
  {
    id: "run_own_routine_now",
    label: "Run own routine now",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "reversible",
  },
  {
    id: "delete_own_routine",
    label: "Delete own routine",
    sourceName: "Routine management",
    groupKey: "routine-management",
    riskClass: "destructive",
  },
];

/** Return the stored autonomy baseline when a tool is newly assigned. */
export function defaultAssignment(option: PersonaToolOption): AssignedToolConfig {
  const requiresApproval =
    option.riskClass === "destructive" ||
    (option.groupKey === "routine-management" && option.riskClass === "reversible");
  return requiresApproval ? { toolId: option.id, autonomy: "approval_required" } : { toolId: option.id };
}

export function personaToolOptions(
  // null = the MCP catalog fetch hasn't come back yet, distinct from `[]`
  // (heard back, server has no approved tools) -- mirrors availableProviders'
  // null-vs-[] distinction below. While null, an already-assigned MCP tool
  // isn't actually confirmed unavailable; don't flash it as such only to
  // have it reappear once the fetch resolves.
  availableMcpTools: AvailableMcpTool[] | null,
  assignedTools: AssignedToolConfig[],
  webSearchAvailable = false,
): PersonaToolOption[] {
  const mcpTools = availableMcpTools ?? [];
  const available = [
    ...NATIVE_TOOL_OPTIONS,
    ...(webSearchAvailable ? [WEB_SEARCH_TOOL_OPTION] : []),
    ...ROUTINE_TOOL_OPTIONS,
    ...mcpTools,
  ];
  const knownIds = new Set(available.map((option) => option.id));
  const unavailable = assignedTools
    .filter(({ toolId }) => !knownIds.has(toolId))
    .filter(({ toolId }) => availableMcpTools !== null || !toolId.startsWith("mcp:"))
    .map(({ toolId }) => ({
      id: toolId,
      label: `${toolId.startsWith("mcp:") ? "Unavailable MCP tool" : "Unavailable tool"}: ${toolId}`,
      sourceName: "Unavailable",
      riskClass: "reversible" as const,
      unavailable: true as const,
    }));
  return [...available, ...unavailable];
}

export function groupPersonaToolOptions(
  options: PersonaToolOption[],
  query: string,
): Array<{ sourceName: string; options: PersonaToolOption[] }> {
  const normalizedQuery = query.trim().toLowerCase();
  const groups = new Map<string, PersonaToolOption[]>();
  for (const option of options) {
    if (
      normalizedQuery &&
      !option.label.toLowerCase().includes(normalizedQuery) &&
      !option.id.toLowerCase().includes(normalizedQuery) &&
      !option.sourceName.toLowerCase().includes(normalizedQuery)
    ) {
      continue;
    }
    const group = groups.get(option.sourceName) ?? [];
    group.push(option);
    groups.set(option.sourceName, group);
  }
  return Array.from(groups, ([sourceName, groupedOptions]) => ({ sourceName, options: groupedOptions }));
}

const inputClass =
  "w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

/**
 * Shared body for hiring a new persona and editing an existing one — a
 * persona's identity, charter, tools, model, and org-chart position are all
 * expected to change over time, not just get set once at hire, so the same
 * fields apply either way. Which mode this is comes from whether `initial`
 * is passed, not a separate prop: create starts every field empty, edit
 * starts every field prefilled from the existing persona.
 */
export function PersonaForm({
  client,
  managerCandidates = [],
  initial,
  draft,
  presentation = "card",
  onSave,
  onSaved,
  onCancel,
  title,
  submitLabel,
  submittingLabel,
  saveErrorLabel,
}: {
  client: ApiClient;
  /** Candidates for "reports to". Callers are responsible for filtering —
   *  e.g. the edit form excludes the persona itself and its descendants so
   *  a reporting cycle can't even be selected, not just rejected server-side. */
  managerCandidates?: Persona[];
  /** The persona being edited. Omit to hire a brand-new one. */
  initial?: Persona;
  /** Seed values for a brand-new persona (e.g. a chosen starter template,
   * Unlike `initial`, this never switches the form into edit
   *  mode, it only fills in the starting values of an otherwise-fresh hire.
   *  Ignored once `initial` is set. */
  draft?: {
    name?: string;
    role?: string;
    systemPrompt?: string;
    scopeDescription?: string;
    voiceNotes?: string;
    boundaries?: string;
    assignedToolIds?: AssignedToolConfig[];
  };
  presentation?: "card" | "sheet";
  onSave: (input: PersonaFormValues) => Promise<Persona>;
  onSaved: (persona: Persona) => void;
  onCancel?: () => void;
  title: string;
  submitLabel: string;
  submittingLabel: string;
  /** e.g. "hire them" / "save changes" — slotted into "Couldn't {label} (status)." */
  saveErrorLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? draft?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? draft?.role ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? draft?.systemPrompt ?? "");
  const [scopeDescription, setScopeDescription] = useState(initial?.scopeDescription ?? draft?.scopeDescription ?? "");
  const [voiceNotes, setVoiceNotes] = useState(initial?.voiceNotes ?? draft?.voiceNotes ?? "");
  const [boundaries, setBoundaries] = useState(initial?.boundaries ?? draft?.boundaries ?? "");
  const [showCharter, setShowCharter] = useState(
    Boolean(
      initial?.scopeDescription ||
      initial?.voiceNotes ||
      initial?.boundaries ||
      draft?.scopeDescription ||
      draft?.voiceNotes ||
      draft?.boundaries,
    ),
  );
  const charterId = useId();
  const [modelProvider, setModelProvider] = useState(initial?.modelProvider ?? "anthropic");
  const [modelName, setModelName] = useState(initial?.modelName ?? "claude-sonnet-5");
  const models = useModelCatalog(client);
  const modelOptions = models?.[modelProvider] ?? [];

  // Keep modelName in sync with the live list: whenever the provider changes
  // (or the catalog finishes loading), if the current value isn't actually
  // one of that provider's models, snap to the first one instead of
  // submitting a stale/empty value the dropdown never actually offered. Only
  // for a brand-new persona: an existing one's `modelName` is its real,
  // already-saved value (still shown in `modelOptions` once the catalog
  // resolves for a *configured* provider) -- editing an unrelated field
  // shouldn't silently change it out from under an unconfigured/stale one.
  useEffect(() => {
    if (initial) return;
    if (modelOptions.length > 0 && !modelOptions.includes(modelName)) {
      setModelName(modelOptions[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelProvider, models]);
  const [reportsTo, setReportsTo] = useState(initial?.reportsTo ?? "");
  const [tools, setTools] = useState<Record<string, AssignedToolConfig>>(() =>
    Object.fromEntries((initial?.assignedToolIds ?? draft?.assignedToolIds ?? []).map((t) => [t.toolId, t])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = "haven't heard back yet" -- deliberately distinct from `[]` (heard
  // back, nothing configured) so the select doesn't flash every provider as
  // unavailable before this resolves.
  const [availableProviders, setAvailableProviders] = useState<string[] | null>(null);
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  // null = "haven't heard back yet" -- see personaToolOptions' doc comment.
  const [mcpToolOptions, setMcpToolOptions] = useState<AvailableMcpTool[] | null>(null);
  const toolOptions = personaToolOptions(mcpToolOptions, Object.values(tools), webSearchAvailable);
  const [toolQuery, setToolQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    client
      .getConfig()
      .then(({ availableProviders: providers, webSearchAvailable: searchAvailable }) => {
        if (cancelled) return;
        setAvailableProviders(providers);
        setWebSearchAvailable(searchAvailable);
        // The default provider (or whatever's currently selected, since this
        // only runs once on mount) has no API key configured -- steer
        // towards one that does, rather than silently letting the user hire
        // a persona that's guaranteed to fail its first job. Only for a
        // brand-new persona: an existing one may have been deliberately left
        // on an unconfigured provider (e.g. mid-migration), and opening the
        // edit form to fix an unrelated field shouldn't silently change it.
        if (!initial && providers.length > 0 && !providers.includes(modelProvider)) {
          setModelProvider(providers[0]!);
        }
      })
      .catch(() => {
        // Config couldn't be fetched -- leave availableProviders at null
        // (don't restrict the picker) rather than blocking persona creation
        // over a transient failure of an endpoint this form only uses for a
        // hint.
      });
    return () => {
      cancelled = true;
    };
    // Only ever run once, on mount: this is a one-time steer away from an
    // unconfigured default, not a live sync with `modelProvider` (which
    // would fight the user's own subsequent selection).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    client.listAvailableMcpTools().then(
      (options) => {
        if (!cancelled) setMcpToolOptions(options);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const persona = await onSave(
        buildPersonaFormValues({
          name,
          role,
          systemPrompt,
          scopeDescription,
          voiceNotes,
          boundaries,
          modelProvider,
          modelName,
          tools,
          reportsTo,
        }),
      );
      onSaved(persona);
      if (!initial) {
        // Reset to a blank slate only after a successful hire — an edit has
        // nowhere to "reset" to, the form just stays showing what was saved.
        setName("");
        setRole("");
        setSystemPrompt("");
        setScopeDescription("");
        setVoiceNotes("");
        setBoundaries("");
        setReportsTo("");
        setTools({});
      }
    } catch (err) {
      setError(err instanceof ApiError ? `Couldn't ${saveErrorLabel} (${err.status}).` : `Couldn't ${saveErrorLabel}.`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={presentation === "card" ? "flex flex-col gap-3 rounded-card border p-5" : "flex flex-col gap-3"}
    >
      {presentation === "card" && <h3 className="m-0 font-serif text-lg text-fg">{title}</h3>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wren"
            required
            className={inputClass}
            style={inputStyle}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Role</span>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Researcher"
            required
            className={inputClass}
            style={inputStyle}
          />
        </label>
      </div>
      <label className="mt-2 flex flex-col gap-1.5">
        <span className="font-sans text-[13px] font-medium text-fg">Core instructions</span>
        <span className="font-sans text-xs text-fg-faint">
          What this person is responsible for and how they should work.
        </span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Describe what they're here to do"
          required
          rows={5}
          className={inputClass}
          style={inputStyle}
        />
      </label>

      <button
        type="button"
        onClick={() => setShowCharter((v) => !v)}
        aria-expanded={showCharter}
        aria-controls={charterId}
        className="flex min-h-11 w-full items-center justify-between gap-4 rounded-button border border-border bg-bg px-3 py-2 text-left text-fg hover:border-border-strong focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-sans text-sm font-medium">Charter</span>
          <span className="font-sans text-xs text-fg-muted">Scope, voice &amp; personality, and boundaries</span>
        </span>
        <span aria-hidden="true" className="flex-none font-sans text-lg leading-none text-fg-faint">
          {showCharter ? "−" : "+"}
        </span>
      </button>
      {showCharter && (
        <div id={charterId} className="flex flex-col gap-4 rounded-card border border-border bg-bg p-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-sans text-[13px] font-medium text-fg">Scope</span>
            <span className="font-sans text-xs text-fg-faint">What work belongs to this person.</span>
            <textarea
              name="scopeDescription"
              autoComplete="off"
              value={scopeDescription}
              onChange={(e) => setScopeDescription(e.target.value)}
              placeholder="Personal correspondence, scheduling, and errands…"
              rows={3}
              className={`${inputClass} min-h-24 [field-sizing:content]`}
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-sans text-[13px] font-medium text-fg">Voice &amp; personality</span>
            <span className="font-sans text-xs text-fg-faint">How they sound and behave when working with you.</span>
            <textarea
              name="voiceNotes"
              autoComplete="off"
              value={voiceNotes}
              onChange={(e) => setVoiceNotes(e.target.value)}
              placeholder="Concise, calm, and concrete…"
              rows={3}
              className={`${inputClass} min-h-24 [field-sizing:content]`}
              style={inputStyle}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-sans text-[13px] font-medium text-fg">Boundaries</span>
            <span className="font-sans text-xs text-fg-faint">Hard limits this person must not cross.</span>
            <textarea
              name="boundaries"
              autoComplete="off"
              value={boundaries}
              onChange={(e) => setBoundaries(e.target.value)}
              placeholder="Never send messages without approval…"
              rows={3}
              className={`${inputClass} min-h-24 [field-sizing:content]`}
              style={inputStyle}
            />
          </label>
        </div>
      )}

      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Provider</span>
          <select
            value={modelProvider}
            onChange={(e) => setModelProvider(e.target.value)}
            className={inputClass}
            style={inputStyle}
          >
            {ALL_PROVIDERS.map((provider) => {
              const configured = availableProviders === null || availableProviders.includes(provider);
              return (
                <option key={provider} value={provider}>
                  {provider === "openai" ? "OpenAI" : "Anthropic"}
                  {configured ? "" : " (no API key configured)"}
                </option>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[13px] font-medium text-fg">Model</span>
          {modelOptions.length > 0 ? (
            <select
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className={inputClass}
              style={inputStyle}
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {displayModelName(modelProvider, m)}
                </option>
              ))}
            </select>
          ) : (
            // No live list for this provider (still loading, no API key
            // configured, or the fetch itself failed) -- fall back to free
            // text instead of a dropdown with nothing in it. This is the path
            // that actually has to work: a persona stuck on an invalid model
            // needs a way to fix it that doesn't depend on the live catalog
            // succeeding first.
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={models === null ? "Loading models…" : "Model name"}
              className={inputClass}
              style={inputStyle}
            />
          )}
        </label>
      </div>
      {availableProviders !== null && !availableProviders.includes(modelProvider) && (
        <p className="m-0 font-sans text-xs" style={{ color: "var(--danger)" }}>
          No API key is configured for {modelProvider} — every job for this persona will fail until one is set.
        </p>
      )}
      {(initial || managerCandidates.length > 0) && (
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[11px] uppercase tracking-wider text-fg-faint">
            Reports to — the org chart
          </span>
          <select
            value={reportsTo ?? ""}
            onChange={(e) => setReportsTo(e.target.value)}
            className={inputClass}
            style={inputStyle}
          >
            <option value="">Nobody — top of the chart</option>
            {managerCandidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} &middot; {p.role}
              </option>
            ))}
          </select>
        </label>
      )}
      <ToolPermissionsEditor
        options={toolOptions}
        tools={tools}
        query={toolQuery}
        onQueryChange={setToolQuery}
        onChange={setTools}
        subjectName={name.trim() || "this persona"}
      />
      {!initial && (
        <p className="m-0 font-sans text-xs text-fg-faint">
          Schedules (routines) are set up from the persona&rsquo;s own page after hiring.
        </p>
      )}
      {error && (
        <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="min-h-11 rounded-button border-0 px-4 py-2 font-sans text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {submitting ? submittingLabel : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-button border px-4 py-2 font-sans text-sm"
            style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
