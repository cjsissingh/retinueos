import type { ApiClient } from "./api-client";

export async function loadJobDetail(client: ApiClient, jobId: string) {
  const job = await client.getJob(jobId);
  const [persona, toolCalls, messages] = await Promise.all([
    client.getPersona(job.personaId).catch(() => null),
    client.listToolCallsForJob(job.id).catch(() => []),
    client.listMessages(job.id).catch(() => []),
  ]);
  return { job, persona, toolCalls, messages };
}
