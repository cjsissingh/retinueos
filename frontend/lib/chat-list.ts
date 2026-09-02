import type { Job, Persona } from "./api-client";

export interface ChatRow {
  job: Job;
  persona: Persona | undefined;
}

/** Every chat (job) across the whole roster, newest first -- the `/chats`
 *  nav destination. Kept out of `app/chats/page.tsx` so the
 *  ordering and persona lookup are testable without the page's
 *  client-component runtime (same seam as `lib/chat-title.ts`). */
export function sortedChatRows(jobs: Job[], personas: Persona[]): ChatRow[] {
  return [...jobs]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((job) => ({ job, persona: personas.find((p) => p.id === job.personaId) }));
}
