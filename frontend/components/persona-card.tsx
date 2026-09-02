import Link from "next/link";
import type { Persona } from "@/lib/api-client";
import { PersonaAvatar } from "./persona-avatar";
import { PersonaStatusBadge, type PersonaLiveStatus } from "./status-badge";

export function PersonaCard({ persona, status }: { persona: Persona; status: PersonaLiveStatus }) {
  return (
    <Link
      href={`/roster/${persona.id}`}
      className="flex flex-col gap-3.5 rounded-card border bg-surface p-5 no-underline shadow-rest transition-shadow hover:shadow-hover"
      style={{ borderColor: "var(--border)", color: "inherit" }}
    >
      <div className="flex items-start gap-3.5">
        <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="m-0 truncate font-sans text-base font-semibold text-fg">{persona.name}</h3>
          </div>
          <p className="m-0 mt-0.5 font-sans text-[13px] text-fg-muted">{persona.role}</p>
        </div>
      </div>
      {persona.scopeDescription && (
        <p className="m-0 font-sans text-[13px] leading-relaxed text-fg-muted [text-wrap:pretty]">
          {persona.scopeDescription}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <PersonaStatusBadge status={status} />
        <span className="font-mono text-[11px] text-fg-faint">
          {persona.modelProvider}/{persona.modelName}
        </span>
      </div>
    </Link>
  );
}
