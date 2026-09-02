import Link from "next/link";
import type { Job, Persona } from "@/lib/api-client";
import { delegatedChatHref } from "@/lib/chat-navigation";
import { PersonaAvatar } from "./persona-avatar";
import { JobStatusBadge } from "./status-badge";

export function DelegationCard({ job, persona }: { job: Job; persona?: Persona }) {
  const name = persona?.name ?? "Delegate";

  return (
    <div
      className="flex max-w-[72%] min-w-0 gap-3 rounded-card border p-3.5"
      style={{ borderColor: "var(--border)", background: "var(--surface-sunken)" }}
    >
      <PersonaAvatar id={job.personaId} name={name} role={persona?.role ?? "Delegate"} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="font-sans text-[13px] font-medium text-fg">Delegated to {name}</span>
          <JobStatusBadge status={job.status} />
        </div>
        {job.prompt && (
          <p className="m-0 mb-2 break-words font-sans text-[13px] leading-relaxed text-fg-muted">{job.prompt}</p>
        )}
        <Link href={delegatedChatHref(job)} className="font-sans text-[13px] font-medium">
          Open full conversation →
        </Link>
      </div>
    </div>
  );
}
