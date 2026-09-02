"use client";

import { useState, type ReactNode } from "react";
import type { ApiClient, Memory, ModelCall, Persona, PersonaStateEntry, Routine } from "@/lib/api-client";
import { RoutineForm } from "./routine-form";
import { displayModelName } from "@/lib/display";

export type SidePanelKind = "routines" | "memory" | "telemetry";

/** Format latency the way an operator reads it at a glance -- ms below a
 *  second, one-decimal seconds above (self-hosted, bring-your-own-key). */
function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// Same shape as the roster/[personaId] page's and logs-content.tsx's own
// copies -- each panel/page keeps a local relativeTime rather than sharing
// one, matching the existing convention in this codebase.
function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Content for the focused sections in a persona's management workspace.
 * Keeping the sections presentational lets the route own navigation and
 * page hierarchy while rows retain their local interaction state.
 */
export function PersonaSidePanel({
  panel,
  onClose,
  persona,
  client,
  routines,
  onRoutineCreated,
  onRoutineUpdated,
  memories,
  onMemoryDeleted,
  loopState,
  onLoopStateDeleted,
  modelCalls,
}: {
  panel: SidePanelKind;
  // Only used to dismiss the whole sheet from the inline "new routine"
  // form's Cancel -- the panel's own chrome (title, close button, Esc,
  // backdrop) belongs to the Sheet the caller wraps this in, not here.
  onClose: () => void;
  persona: Persona;
  client: ApiClient;
  routines: Routine[];
  onRoutineCreated: (r: Routine) => void;
  onRoutineUpdated: (r: Routine) => void;
  memories: Memory[];
  onMemoryDeleted: (id: string) => void;
  loopState: PersonaStateEntry[];
  onLoopStateDeleted: (key: string) => void;
  modelCalls: ModelCall[];
}) {
  return (
    <div>
      {panel === "routines" && (
        <div className="flex flex-col gap-4">
          <div className="overflow-visible rounded-card border" style={{ borderColor: "var(--border)" }}>
            {routines.length === 0 && (
              <p className="p-4.5 font-sans text-sm text-fg-muted">
                No routines yet — {persona.name} only runs when asked.
              </p>
            )}
            {routines.map((r) => (
              <RoutineRow key={r.id} client={client} routine={r} onUpdated={onRoutineUpdated} />
            ))}
          </div>
          <RoutineForm client={client} personaId={persona.id} onCreated={onRoutineCreated} onCancel={onClose} />
        </div>
      )}

      {panel === "memory" && (
        <div className="flex flex-col gap-6">
          <MemorySection
            title="Loop notes"
            empty="No loop notes yet — this person isn't tracking a named list between jobs."
            isEmpty={loopState.length === 0}
          >
            {loopState.map((entry) => (
              <LoopStateRow
                key={entry.id}
                client={client}
                personaId={persona.id}
                entry={entry}
                onDeleted={() => onLoopStateDeleted(entry.key)}
              />
            ))}
          </MemorySection>
          <MemorySection title="Facts" empty="No durable memories yet." isEmpty={memories.length === 0}>
            {memories.map((m) => (
              <MemoryRow
                key={m.id}
                client={client}
                personaId={persona.id}
                memory={m}
                onDeleted={() => onMemoryDeleted(m.id)}
              />
            ))}
          </MemorySection>
        </div>
      )}

      {panel === "telemetry" && (
        <div className="flex flex-col gap-4">
          {modelCalls.length === 0 ? (
            <p className="font-sans text-sm text-fg-muted">No model calls recorded yet.</p>
          ) : (
            <>
              <ModelCallSummary calls={modelCalls} />
              <div className="overflow-hidden rounded-card border" style={{ borderColor: "var(--border)" }}>
                {modelCalls.map((call) => (
                  <ModelCallRow key={call.id} call={call} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Aggregate strip above the model-calls list -- call count and total
 *  tokens across the window listModelCalls returns (most recent 100, per
 *  model-call-repo.ts). No $-cost here: nothing in the codebase carries
 *  per-token pricing (model-catalog.ts only fetches provider/model names),
 *  and inventing a number would be worse than omitting one. */
function ModelCallSummary({ calls }: { calls: ModelCall[] }) {
  const totalTokens = calls.reduce((sum, c) => sum + (c.totalTokens ?? 0), 0);
  const errorCount = calls.filter((c) => c.error).length;
  const avgLatency = Math.round(calls.reduce((sum, c) => sum + c.latencyMs, 0) / calls.length);

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border px-4.5 py-3"
      style={{ borderColor: "var(--border)", background: "var(--surface-sunken)" }}
    >
      <div>
        <p className="m-0 font-mono text-[10px] uppercase tracking-wider text-fg-faint">Calls</p>
        <p className="m-0 font-sans text-sm font-medium text-fg">{calls.length}</p>
      </div>
      <div>
        <p className="m-0 font-mono text-[10px] uppercase tracking-wider text-fg-faint">Total tokens</p>
        <p className="m-0 font-sans text-sm font-medium text-fg">{totalTokens.toLocaleString()}</p>
      </div>
      <div>
        <p className="m-0 font-mono text-[10px] uppercase tracking-wider text-fg-faint">Avg latency</p>
        <p className="m-0 font-sans text-sm font-medium text-fg">{formatLatency(avgLatency)}</p>
      </div>
      {errorCount > 0 && (
        <div>
          <p className="m-0 font-mono text-[10px] uppercase tracking-wider text-fg-faint">Errors</p>
          <p className="m-0 font-sans text-sm font-medium" style={{ color: "var(--danger)" }}>
            {errorCount}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One model_calls row -- provider/model as the primary line, latency/token
 * counts/when as a meta line underneath rather than provider,
 * latency, and relative time all sitting as separate flex-none items in
 * one row: this panel is always a narrow column (a full-width mobile sheet
 * or a fixed 460px desktop one -- see components/ui/sheet.tsx), never a
 * wide desktop grid, so unlike Logs/Audit there's no `md:` variant to keep
 * -- the two-line shape applies at every width this panel ever renders at.
 */
function ModelCallRow({ call }: { call: ModelCall }) {
  const tokenParts: string[] = [];
  if (call.promptTokens != null) tokenParts.push(`${call.promptTokens} in`);
  if (call.completionTokens != null) tokenParts.push(`${call.completionTokens} out`);
  if (call.totalTokens != null) tokenParts.push(`${call.totalTokens} total`);

  return (
    <div
      className="flex min-h-11 flex-col justify-center gap-1 border-b px-4.5 py-3 last:border-b-0"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate font-sans text-sm text-fg">
            {displayModelName(call.provider, call.model)}
          </span>
          <code className="block truncate font-mono text-[10px] text-fg-faint">
            {call.provider}/{call.model}
          </code>
        </span>
        {call.error && (
          <span
            className="flex-none rounded-badge px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
            style={{ color: "var(--danger)", background: "var(--danger-soft)" }}
          >
            Error
          </span>
        )}
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 overflow-hidden font-mono text-[11px] text-fg-faint">
        <span className="flex-none">{formatLatency(call.latencyMs)}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{tokenParts.length > 0 ? tokenParts.join(" · ") : "no token counts recorded"}</span>
        <span aria-hidden="true">·</span>
        <span className="flex-none">{relativeTime(call.createdAt)}</span>
      </p>
      {call.error && (
        <p className="m-0 truncate font-sans text-[12px]" style={{ color: "var(--danger)" }} title={call.error}>
          {call.error}
        </p>
      )}
    </div>
  );
}

function MemorySection({
  title,
  empty,
  isEmpty,
  children,
}: {
  title: string;
  empty: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="m-0 mb-2 font-mono text-[11px] uppercase tracking-wider text-fg-faint">{title}</p>
      <div className="overflow-hidden rounded-card border" style={{ borderColor: "var(--border)" }}>
        {isEmpty ? <p className="p-4.5 font-sans text-sm text-fg-muted">{empty}</p> : children}
      </div>
    </div>
  );
}

/** One persona_state key. Forget uses the same in-flight/error pattern as MemoryRow. */
function LoopStateRow({
  client,
  personaId,
  entry,
  onDeleted,
}: {
  client: ApiClient;
  personaId: string;
  entry: PersonaStateEntry;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function forget() {
    setDeleting(true);
    setError(null);
    try {
      await client.deletePersonaState(personaId, entry.key);
      onDeleted();
    } catch {
      setError("Couldn't forget that.");
      setDeleting(false);
    }
  }

  return (
    <div
      className="flex items-start gap-3.5 border-b px-4.5 py-3 last:border-b-0"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 font-sans text-sm font-medium text-fg">{entry.key}</p>
        <p className="m-0 mt-1 whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-fg-muted">
          {entry.content || "(empty)"}
        </p>
        <p className="m-0 mt-1.5 font-mono text-[11px] text-fg-faint">Updated {relativeTime(entry.updatedAt)}</p>
        {error && (
          <p className="m-0 mt-1 font-sans text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={deleting}
        onClick={forget}
        className="flex-none rounded-button border px-2 py-1 font-sans text-[11px] disabled:opacity-50"
        style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
      >
        {deleting ? "…" : "Forget"}
      </button>
    </div>
  );
}

/** Importance (0 background .. 2 important) as three filled/empty dots --
 *  same instinct as RiskBadge, a glanceable signal rather than a number
 *  that needs reading. */
function ImportanceDots({ importance }: { importance: 0 | 1 | 2 }) {
  return (
    <span className="flex items-center gap-0.5" title={`Importance ${importance}/2`} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: i <= importance ? "var(--accent)" : "var(--border-strong)" }}
        />
      ))}
    </span>
  );
}

/** One memory's row in the panel -- its own delete in-flight/error state,
 *  same shape as RoutineRow below (one row's own loading/error state,
 *  update-parent-on-success via a callback). */
function MemoryRow({
  client,
  personaId,
  memory,
  onDeleted,
}: {
  client: ApiClient;
  personaId: string;
  memory: Memory;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function forget() {
    setDeleting(true);
    setError(null);
    try {
      await client.deleteMemory(personaId, memory.id);
      onDeleted();
    } catch {
      setError("Couldn't forget that.");
      setDeleting(false);
    }
  }

  return (
    <div
      className="flex items-start gap-3.5 border-b px-4.5 py-3 last:border-b-0"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="m-0 font-sans text-sm font-medium text-fg">{memory.label}</p>
          <ImportanceDots importance={memory.importance} />
          {memory.sensitivity === "sensitive" && (
            <span
              className="rounded-badge px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider"
              style={{ color: "var(--warning-soft-fg)", background: "var(--warning-soft)" }}
            >
              Sensitive
            </span>
          )}
        </div>
        <p className="m-0 mt-1 whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-fg-muted">
          {memory.content}
        </p>
        <p className="m-0 mt-1.5 font-mono text-[11px] text-fg-faint">
          {memory.lastAccessedAt
            ? `Last recalled ${relativeTime(memory.lastAccessedAt)}`
            : `Created ${relativeTime(memory.createdAt)}`}
        </p>
        {error && (
          <p className="m-0 mt-1 font-sans text-[12px]" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={deleting}
        onClick={forget}
        className="flex-none rounded-button border px-2 py-1 font-sans text-[11px] disabled:opacity-50"
        style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
      >
        {deleting ? "…" : "Forget"}
      </button>
    </div>
  );
}

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}

/**
 * One routine's row in the panel — its own pause/resume and run-now
 * in-flight state, so one row's action never disables another's while it's
 * pending. Name + schedule share one line; Notify/Run now/Pause used to sit
 * as three side-by-side buttons past the schedule, which is exactly what
 * ran this row past 390px -- they're a trailing overflow menu
 * (the Sheet primitive is the wrong weight for three inline actions, so
 * this is a small anchored popover instead, the same pattern the roster
 * page's own header "More" menu already uses).
 */
function RoutineRow({
  client,
  routine,
  onUpdated,
}: {
  client: ApiClient;
  routine: Routine;
  onUpdated: (r: Routine) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [togglingNotify, setTogglingNotify] = useState(false);
  const [running, setRunning] = useState(false);
  const [runNowSent, setRunNowSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  async function toggleEnabled() {
    setMenuOpen(false);
    setToggling(true);
    setError(null);
    try {
      onUpdated(await client.setRoutineEnabled(routine.id, !routine.enabled));
    } catch {
      setError("Couldn't change that.");
    } finally {
      setToggling(false);
    }
  }

  async function toggleNotify() {
    setMenuOpen(false);
    setTogglingNotify(true);
    setError(null);
    try {
      onUpdated(await client.setRoutineNotifyRoutineRan(routine.id, !routine.notifyRoutineRan));
    } catch {
      setError("Couldn't change that.");
    } finally {
      setTogglingNotify(false);
    }
  }

  async function runNow() {
    setMenuOpen(false);
    setRunning(true);
    setError(null);
    try {
      await client.runRoutineNow(routine.id);
      setRunNowSent(true);
    } catch {
      setError("Couldn't run that now.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex min-h-11 items-start gap-2.5 px-4.5 py-3">
        <div className="min-w-0 flex-1">
          <p
            className="m-0 flex items-center gap-1.5 font-sans text-sm font-medium text-fg"
            style={{ opacity: routine.enabled ? 1 : 0.55 }}
          >
            <span className="min-w-0 truncate">{routine.name}</span>
            {routine.kind === "digest" && (
              <span
                className="flex-none rounded-full border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint"
                style={{ borderColor: "var(--border-strong)" }}
              >
                Digest
              </span>
            )}
            <code className="ml-auto flex-none font-mono text-[11px] font-normal text-fg-faint">
              {routine.cronSchedule}
            </code>
          </p>
          <p className="m-0 mt-0.5 truncate font-sans text-[13px] text-fg-muted">
            {routine.kind === "digest" ? "Scans state and recent job outcomes, no chat turn." : routine.promptTemplate}
          </p>
          {error && (
            <p className="m-0 mt-1 font-sans text-[12px]" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${routine.name}`}
            className="grid h-11 w-11 place-items-center rounded-button border-0 bg-transparent text-fg-muted"
          >
            <KebabIcon />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-full top-0 z-10 mr-1 w-52 rounded-card border py-1 shadow-overlay"
              style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setEditing(true);
                }}
                className="flex min-h-11 w-full items-center px-3 text-left font-sans text-[13px]"
                style={{ color: "var(--fg)", background: "transparent", border: 0 }}
              >
                Edit details
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={running || runNowSent}
                onClick={runNow}
                className="flex min-h-11 w-full items-center px-3 text-left font-sans text-[13px] disabled:opacity-50"
                style={{ color: "var(--fg)", background: "transparent", border: 0 }}
              >
                {runNowSent ? "Queued" : running ? "Running…" : "Run now"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={toggling}
                onClick={toggleEnabled}
                className="flex min-h-11 w-full items-center px-3 text-left font-sans text-[13px] disabled:opacity-50"
                style={{ color: "var(--fg)", background: "transparent", border: 0 }}
              >
                {toggling ? "…" : routine.enabled ? "Pause" : "Resume"}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={togglingNotify}
                onClick={toggleNotify}
                className="flex min-h-11 w-full items-center border-t px-3 text-left font-sans text-[13px] disabled:opacity-50"
                style={{ color: "var(--fg)", background: "transparent", borderColor: "var(--border)" }}
              >
                {togglingNotify ? "…" : routine.notifyRoutineRan ? "Turn off notify" : "Notify when this routine runs"}
              </button>
            </div>
          )}
        </div>
      </div>
      {editing && (
        <div className="px-4.5 pb-4">
          <RoutineForm
            client={client}
            personaId={routine.personaId}
            routine={routine}
            onUpdated={onUpdated}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}
    </div>
  );
}
