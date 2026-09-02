import Link from "next/link";
import type { Digest, Persona } from "@/lib/api-client";
import { PersonaAvatar } from "@/components/persona-avatar";
import { LIST_ROW, TWO_LINE_META, TWO_LINE_ROW } from "@/lib/touch-layout";

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function preview(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 120) return collapsed;
  return `${collapsed.slice(0, 119)}…`;
}

/**
 * Digest rows on Logs — same two-line mobile / grid desktop shape as the
 * job list, so switching Jobs ↔ Digests doesn't change the page's rhythm.
 * Digests aren't jobs (no chat turn, no jobs row), which is why they need
 * their own list instead of a status filter on GET /jobs.
 */
export function DigestHistoryList({ digests, personas }: { digests: Digest[]; personas: Persona[] }) {
  const personaById = new Map(personas.map((p) => [p.id, p]));

  return (
    <>
      <div className="hidden grid-cols-[1fr_150px_100px_110px] gap-4 border-b border-border bg-surface-sunken px-5 py-2.5 font-mono text-[11px] uppercase tracking-wider text-fg-faint md:grid">
        <span>Report</span>
        <span>Who</span>
        <span>When ▾</span>
        <span>Digest</span>
      </div>
      {digests.map((digest) => {
        const persona = personaById.get(digest.personaId);
        const summary = preview(digest.content);
        return (
          <Link
            key={digest.id}
            href={`/logs/digests/${digest.id}`}
            className={`${LIST_ROW} block border-b border-border px-4 text-fg no-underline last:border-b-0 md:px-5`}
          >
            <div className={TWO_LINE_ROW}>
              <span className="truncate font-sans text-sm text-fg" title={digest.content}>
                {summary || "Empty digest"}
              </span>
              <span className={TWO_LINE_META}>
                <span className="max-w-[120px] truncate">{persona?.name ?? "—"}</span>
                <span aria-hidden="true">·</span>
                <span className="flex-none">{relativeTime(digest.generatedAt)}</span>
              </span>
            </div>
            <div className="hidden py-3 md:grid md:grid-cols-[1fr_150px_100px_110px] md:items-center md:gap-4">
              <span className="truncate font-sans text-sm text-fg" title={digest.content}>
                {summary || "Empty digest"}
              </span>
              <span className="flex items-center gap-2 font-sans text-[13px] text-fg-muted">
                {persona ? (
                  <>
                    <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
                    {persona.name}
                  </>
                ) : (
                  "—"
                )}
              </span>
              <span className="font-mono text-xs text-fg-muted">{relativeTime(digest.generatedAt)}</span>
              <code className="font-mono text-xs text-fg-faint">{digest.id.slice(0, 8)}</code>
            </div>
          </Link>
        );
      })}
    </>
  );
}
