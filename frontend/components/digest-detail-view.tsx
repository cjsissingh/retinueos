import type { Digest, Persona } from "@/lib/api-client";
import { PAGE_PAD } from "@/lib/touch-layout";
import { PageHeader } from "./page-header";
import { PersonaAvatar } from "./persona-avatar";

export function DigestDetailView({ digest, persona }: { digest: Digest; persona: Persona | null }) {
  const when = new Date(digest.generatedAt).toLocaleString();
  const origin = digest.routineId ? "Scheduled digest" : "On demand";

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={`${origin} · ${digest.id.slice(0, 8)}`}
        title="Digest"
        description={when}
        backHref="/logs?view=digests"
        actions={
          persona ? (
            <span className="inline-flex items-center gap-2 font-sans text-sm text-fg-muted">
              <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
              {persona.name}
            </span>
          ) : undefined
        }
      />
      <div className="max-w-[760px] whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-fg">
        {digest.content}
      </div>
    </main>
  );
}
