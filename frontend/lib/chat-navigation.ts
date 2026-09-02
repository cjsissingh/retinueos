import type { Job } from "./api-client";

export function delegatedChatHref(job: Pick<Job, "id" | "personaId">): string {
  return `/roster/${encodeURIComponent(job.personaId)}?chat=${encodeURIComponent(job.id)}`;
}

export function selectRequestedChat(jobs: Job[], requestedJobId: string | null): string | null {
  if (requestedJobId === "new") return null;
  if (requestedJobId && jobs.some((job) => job.id === requestedJobId)) return requestedJobId;
  const newest = [...jobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  return newest?.id ?? null;
}
