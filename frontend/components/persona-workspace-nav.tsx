import Link from "next/link";

export type PersonaWorkspaceSection = "identity" | "charter" | "tools" | "team" | "routines" | "memory" | "telemetry";

/** Item counts shown next to the nav rows that hold a list -- Identity,
 *  Charter, and Usage aren't lists, so they never carry one. */
export interface PersonaWorkspaceCounts {
  tools: number;
  team: number;
  routines: number;
  memory: number;
}

const SECTIONS: Array<{ id: PersonaWorkspaceSection; label: string; countKey?: keyof PersonaWorkspaceCounts }> = [
  { id: "identity", label: "Identity" },
  { id: "charter", label: "Charter" },
  { id: "tools", label: "Tools", countKey: "tools" },
  { id: "team", label: "Team", countKey: "team" },
  { id: "routines", label: "Routines", countKey: "routines" },
  { id: "memory", label: "Memory", countKey: "memory" },
  { id: "telemetry", label: "Usage" },
];

export function isPersonaWorkspaceSection(value: string | null): value is PersonaWorkspaceSection {
  return SECTIONS.some((section) => section.id === value);
}

export function PersonaWorkspaceNav({
  personaId,
  active,
  counts,
}: {
  personaId: string;
  active: PersonaWorkspaceSection;
  counts: PersonaWorkspaceCounts;
}) {
  return (
    <nav aria-label="Persona workspace" className="min-w-0 border-b md:w-44 md:flex-none md:border-b-0 md:border-r">
      <div className="flex min-w-max gap-1 overflow-x-auto pb-3 md:min-w-0 md:flex-col md:overflow-visible md:pb-0 md:pr-6">
        {SECTIONS.map((section) => {
          const current = section.id === active;
          const count = section.countKey ? counts[section.countKey] : undefined;
          return (
            <Link
              key={section.id}
              href={`/roster/${personaId}/manage?section=${section.id}`}
              aria-current={current ? "page" : undefined}
              className="inline-flex min-h-11 items-center justify-between gap-2 rounded-button border-l-2 px-3 font-sans text-sm no-underline"
              style={{
                borderColor: current ? "var(--accent)" : "transparent",
                background: current ? "var(--accent-soft)" : "transparent",
                color: current ? "var(--fg)" : "var(--fg-muted)",
              }}
            >
              <span>{section.label}</span>
              {count !== undefined && <span className="font-mono text-[11px] text-fg-faint">{count}</span>}
            </Link>
          );
        })}
      </div>
      <Link
        href={`/roster/${personaId}`}
        className="mt-5 hidden min-h-11 items-center px-3 font-sans text-sm text-fg-muted md:inline-flex"
      >
        <span aria-hidden="true">←</span>&nbsp; Back to chat
      </Link>
    </nav>
  );
}
