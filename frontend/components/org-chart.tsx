import Link from "next/link";
import type { Job, Persona } from "@/lib/api-client";
import { PersonaAvatar } from "./persona-avatar";
import { PersonaStatusBadge, derivePersonaStatus } from "./status-badge";

const LINE_COLOR = "var(--border-strong)";
const STEM_HEIGHT = 20; // px — vertical drop between a box and the rail below/above it

/** Mobile list vs desktop tree. Tests lock that a phone does not get a
 *  shrunk copy of the connector-line chart. */
export const ORG_CHART_LAYOUT = {
  mobileList: "flex flex-col gap-2 md:hidden",
  mobileRow: "flex min-h-11 items-center gap-3 rounded-card border bg-surface px-3 py-2.5 no-underline shadow-rest",
  desktopTree: "hidden min-w-0 overflow-x-auto rounded-card border p-6 md:block",
} as const;

/**
 * Groups personas by manager (`reportsTo`). A persona whose `reportsTo`
 * points at itself or at an id not present in `personas` — bad data that
 * shouldn't be possible given the backend's cycle/existence checks, but
 * cheap to guard against here too — is treated as top-of-chart rather than
 * silently dropped from the tree.
 */
function groupByManager(personas: Persona[]): Map<string | null, Persona[]> {
  const ids = new Set(personas.map((p) => p.id));
  const byManager = new Map<string | null, Persona[]>();
  for (const p of personas) {
    const key = p.reportsTo && p.reportsTo !== p.id && ids.has(p.reportsTo) ? p.reportsTo : null;
    const siblings = byManager.get(key) ?? [];
    siblings.push(p);
    byManager.set(key, siblings);
  }
  return byManager;
}

function OrgChartBox({ persona, jobs }: { persona: Persona; jobs: Job[] }) {
  return (
    <Link
      href={`/roster/${persona.id}`}
      className="flex w-[172px] flex-none flex-col items-center gap-2 rounded-card border bg-surface px-3 py-3 text-center no-underline shadow-rest transition-shadow hover:shadow-hover"
      style={{ borderColor: "var(--border)", color: "inherit" }}
    >
      <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="md" />
      <span className="min-w-0">
        <span className="block truncate font-sans text-[13px] font-semibold text-fg">{persona.name}</span>
        <span className="block truncate font-sans text-[12px] text-fg-muted">{persona.role}</span>
      </span>
      <PersonaStatusBadge status={derivePersonaStatus(jobs, persona.id)} />
    </Link>
  );
}

/** The horizontal rail segment a child hangs off of, plus its own vertical
 *  drop into its box. Each child only ever draws *its own* half of the
 *  rail — a line from its center to whichever outer edge it owns (both
 *  edges for a middle child, one edge for an end child, neither for an
 *  only child) — so the combined row reads as one continuous bar from the
 *  first child's center to the last child's, however wide each box is,
 *  with no measurement or absolute-width math required. */
function ChildConnector({ isFirst, isLast, isOnly }: { isFirst: boolean; isLast: boolean; isOnly: boolean }) {
  return (
    <div className="relative w-full flex-none" style={{ height: STEM_HEIGHT }} aria-hidden="true">
      {!isOnly && (
        <div
          className="absolute top-0 h-px"
          style={{ background: LINE_COLOR, left: isFirst ? "50%" : 0, right: isLast ? "50%" : 0 }}
        />
      )}
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2" style={{ background: LINE_COLOR }} />
    </div>
  );
}

function OrgChartNode({
  persona,
  byManager,
  jobs,
}: {
  persona: Persona;
  byManager: Map<string | null, Persona[]>;
  jobs: Job[];
}) {
  const reports = byManager.get(persona.id) ?? [];
  return (
    <div className="flex flex-col items-center">
      <OrgChartBox persona={persona} jobs={jobs} />
      {reports.length > 0 && (
        <>
          <div className="w-px flex-none" style={{ height: STEM_HEIGHT, background: LINE_COLOR }} aria-hidden="true" />
          <div className="flex items-start">
            {reports.map((report, i) => (
              <div key={report.id} className="flex flex-col items-center px-3">
                <ChildConnector isFirst={i === 0} isLast={i === reports.length - 1} isOnly={reports.length === 1} />
                <OrgChartNode persona={report} byManager={byManager} jobs={jobs} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OrgChartListNode({
  persona,
  byManager,
  jobs,
  depth,
}: {
  persona: Persona;
  byManager: Map<string | null, Persona[]>;
  jobs: Job[];
  depth: number;
}) {
  const reports = byManager.get(persona.id) ?? [];
  return (
    <>
      <Link
        href={`/roster/${persona.id}`}
        className={ORG_CHART_LAYOUT.mobileRow}
        style={{
          borderColor: "var(--border)",
          color: "inherit",
          marginLeft: depth * 16,
        }}
      >
        <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[13px] font-semibold text-fg">{persona.name}</span>
          <span className="block truncate font-sans text-[12px] text-fg-muted">{persona.role}</span>
        </span>
        <PersonaStatusBadge status={derivePersonaStatus(jobs, persona.id)} />
      </Link>
      {reports.map((report) => (
        <OrgChartListNode key={report.id} persona={report} byManager={byManager} jobs={jobs} depth={depth + 1} />
      ))}
    </>
  );
}

/** The roster's org chart — a real top-down chart with boxes and connector
 *  lines, read from each persona's `reportsTo`. Top-of-chart personas (no
 *  manager, or an orphaned `reportsTo`) render as independent trees side by
 *  side; the common case is exactly one — the Principal — at the top.
 *  Below `md` the same tree is an indented list so a phone can read and
 *  tap rows instead of panning a miniature desktop chart. */
export function OrgChart({ personas, jobs }: { personas: Persona[]; jobs: Job[] }) {
  const byManager = groupByManager(personas);
  const roots = byManager.get(null) ?? [];

  if (roots.length === 0) return null;

  return (
    <>
      <div className={ORG_CHART_LAYOUT.mobileList}>
        {roots.map((persona) => (
          <OrgChartListNode key={persona.id} persona={persona} byManager={byManager} jobs={jobs} depth={0} />
        ))}
      </div>
      <div
        className={ORG_CHART_LAYOUT.desktopTree}
        style={{ borderColor: "var(--border)", background: "var(--surface-sunken)" }}
      >
        <div className="flex w-fit min-w-full items-start justify-center gap-10">
          {roots.map((persona) => (
            <OrgChartNode key={persona.id} persona={persona} byManager={byManager} jobs={jobs} />
          ))}
        </div>
      </div>
    </>
  );
}
