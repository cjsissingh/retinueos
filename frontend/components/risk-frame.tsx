import type { ReactNode } from "react";
import type { RiskClass } from "@/lib/api-client";

interface RiskMeta {
  label: string;
  borderWidth: number;
  borderColor: string;
  badgeFg?: string;
  badgeBg?: string;
  headingColor?: string;
}

// Every entry lists all of RiskMeta's fields (undefined where inapplicable)
// so each branch has the same shape -- with `satisfies` instead of a
// `: Record<RiskClass, RiskMeta>` annotation, an inconsistent shape per
// branch would otherwise make RISK_META[riskClass] a union that doesn't
// support reading an optional field unconditionally.
const RISK_META = {
  read_only: {
    label: "Safe",
    borderWidth: 1,
    borderColor: "var(--border)",
    badgeFg: undefined,
    badgeBg: undefined,
    headingColor: undefined,
  },
  reversible: {
    label: "Reversible",
    borderWidth: 3,
    borderColor: "var(--warning)",
    badgeFg: "var(--warning-soft-fg)",
    badgeBg: "var(--warning-soft)",
    headingColor: undefined,
  },
  destructive: {
    label: "Destructive · cannot undo",
    borderWidth: 4,
    borderColor: "var(--danger)",
    badgeFg: "var(--danger-soft-fg)",
    badgeBg: "var(--danger-soft)",
    headingColor: "var(--danger-soft-fg)",
  },
} satisfies Record<RiskClass, RiskMeta>;

/** Left-border risk framing used on approval cards and (optionally) tool
 * call rows — the risk class should read before a single word does.
 * `framed` defaults to on for existing callers (ApprovalItem, /logs); the
 * persona chat transcript passes `framed={false}` (the "approval card
 * is the only bordered element in the transcript") and relies on
 * `RiskBadge` alone to carry the risk class there instead. */
export function RiskFrame({
  riskClass,
  children,
  className = "",
  framed = true,
}: {
  riskClass: RiskClass;
  children: ReactNode;
  className?: string;
  framed?: boolean;
}) {
  if (!framed) return <div className={`min-w-0 ${className}`}>{children}</div>;

  const meta = RISK_META[riskClass];
  return (
    <div
      className={`rounded-r-card border border-l-0 bg-surface ${className}`}
      style={{
        borderColor: "var(--border)",
        borderLeftWidth: meta.borderWidth,
        borderLeftColor: meta.borderColor,
        borderLeftStyle: "solid",
      }}
    >
      {children}
    </div>
  );
}

export function RiskBadge({ riskClass }: { riskClass: RiskClass }) {
  const meta = RISK_META[riskClass];
  if (!meta.badgeBg) return null;
  return (
    <span
      className="rounded-badge px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider"
      style={{ color: meta.badgeFg, background: meta.badgeBg }}
    >
      {meta.label}
    </span>
  );
}
