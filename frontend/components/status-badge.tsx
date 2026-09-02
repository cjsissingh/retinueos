import type { JobStatus } from "@/lib/api-client";

interface StatusMeta {
  label: string;
  fg: string;
  bg: string;
  dot: string;
  pulse?: boolean;
}

// Every entry lists all of StatusMeta's fields (pulse: false where
// inapplicable) so each branch has the same shape -- with `satisfies`
// instead of a `: Record<K, StatusMeta>` annotation, an inconsistent shape
// per branch would otherwise make a lookup into these maps a union that
// doesn't support reading `pulse` unconditionally.
const JOB_STATUS_META = {
  queued: {
    label: "Queued",
    fg: "var(--neutral-soft-fg)",
    bg: "var(--neutral-soft)",
    dot: "var(--neutral)",
    pulse: false,
  },
  running: {
    label: "Running",
    fg: "var(--running-soft-fg)",
    bg: "var(--running-soft)",
    dot: "var(--running)",
    pulse: true,
  },
  cancelling: {
    label: "Cancelling",
    fg: "var(--warning-soft-fg)",
    bg: "var(--warning-soft)",
    dot: "var(--warning)",
    pulse: true,
  },
  waiting_approval: {
    label: "Waiting for approval",
    fg: "var(--warning-soft-fg)",
    bg: "var(--warning-soft)",
    dot: "var(--warning)",
    pulse: false,
  },
  done: {
    label: "Done",
    fg: "var(--success-soft-fg)",
    bg: "var(--success-soft)",
    dot: "var(--success)",
    pulse: false,
  },
  failed: {
    label: "Failed",
    fg: "var(--danger-soft-fg)",
    bg: "var(--danger-soft)",
    dot: "var(--danger)",
    pulse: false,
  },
  cancelled: {
    label: "Cancelled",
    fg: "var(--neutral-soft-fg)",
    bg: "var(--neutral-soft)",
    dot: "var(--neutral)",
    pulse: false,
  },
  timed_out: {
    label: "Timed out",
    fg: "var(--danger-soft-fg)",
    bg: "var(--danger-soft)",
    dot: "var(--danger)",
    pulse: false,
  },
  outcome_unknown: {
    label: "Check outcome",
    fg: "var(--danger-soft-fg)",
    bg: "var(--danger-soft)",
    dot: "var(--danger)",
    pulse: false,
  },
} satisfies Record<JobStatus, StatusMeta>;

export type PersonaLiveStatus = "idle" | "on_it" | "needs_you";

const PERSONA_STATUS_META = {
  idle: { label: "Idle", fg: "var(--neutral-soft-fg)", bg: "var(--neutral-soft)", dot: "var(--neutral)", pulse: false },
  on_it: {
    label: "On it",
    fg: "var(--running-soft-fg)",
    bg: "var(--running-soft)",
    dot: "var(--running)",
    pulse: true,
  },
  needs_you: {
    label: "Needs you",
    fg: "var(--warning-soft-fg)",
    bg: "var(--warning-soft)",
    dot: "var(--warning)",
    pulse: false,
  },
} satisfies Record<PersonaLiveStatus, StatusMeta>;

/** Derives a persona's live status from its own jobs — persona.status in the
 * database is never updated by the backend today, so trusting it would show
 * "idle" forever. A job queued, running, or waiting on approval is the
 * signal that matters. */
export function derivePersonaStatus(
  jobs: Array<{ personaId: string; status: JobStatus }>,
  personaId: string,
): PersonaLiveStatus {
  const own = jobs.filter((j) => j.personaId === personaId);
  if (own.some((j) => j.status === "waiting_approval")) return "needs_you";
  if (own.some((j) => j.status === "queued" || j.status === "running" || j.status === "cancelling")) return "on_it";
  return "idle";
}

function Dot({ meta }: { meta: StatusMeta }) {
  return (
    <i
      className={meta.pulse ? "status-dot-running" : undefined}
      style={{ width: 6, height: 6, borderRadius: 999, background: meta.dot, display: "inline-block", flex: "none" }}
    />
  );
}

function StatusBadge({ meta, className = "" }: { meta: StatusMeta; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-badge px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-wider ${className}`}
      style={{ color: meta.fg, background: meta.bg }}
    >
      <Dot meta={meta} />
      {meta.label}
    </span>
  );
}

export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  return <StatusBadge meta={JOB_STATUS_META[status]} className={className} />;
}

export function jobStatusLabel(status: JobStatus): string {
  return JOB_STATUS_META[status].label;
}

export function PersonaStatusBadge({ status, className }: { status: PersonaLiveStatus; className?: string }) {
  return <StatusBadge meta={PERSONA_STATUS_META[status]} className={className} />;
}
