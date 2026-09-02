import type { DrizzleDb } from "../db/client.js";
import { MAX_SUMMARY_CHARS, type ThreadSummary } from "../graph/thread-hygiene.js";
import { getLiveMemoryByLabel, JOB_SUMMARY_LABEL_PREFIX, rememberJobSummaryMemory } from "./persona-memory-repo.js";

const SUMMARY_MARKER = /^Summary through checkpoint message (\d+):\n\n([\s\S]*)$/;

export function jobSummaryLabel(jobId: string): string {
  return `${JOB_SUMMARY_LABEL_PREFIX}${jobId}`;
}

/**
 * Human-readable content with a machine-readable boundary marker. The count
 * is the append-only checkpoint message index immediately after the last
 * summarized message. Keeping it beside the summary avoids a schema change,
 * while rememberMemory's supersession chain preserves every prior version.
 */
function formatJobSummary(summary: ThreadSummary): string {
  return `Summary through checkpoint message ${summary.summarizedMessageCount}:\n\n${summary.summary}`;
}

export function parseJobSummary(content: string): ThreadSummary | undefined {
  const match = SUMMARY_MARKER.exec(content);
  if (!match) return undefined;
  const summarizedMessageCount = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(summarizedMessageCount) || summarizedMessageCount < 0) return undefined;
  const summary = match[2]!;
  if (summary.length > MAX_SUMMARY_CHARS) return undefined;
  if (summarizedMessageCount > 0 && !summary.trim()) return undefined;
  return { summarizedMessageCount, summary };
}

export async function loadJobSummary(
  db: DrizzleDb,
  personaId: string,
  jobId: string,
): Promise<ThreadSummary | undefined> {
  const memory = await getLiveMemoryByLabel(db, personaId, jobSummaryLabel(jobId));
  if (!memory || memory.sourceJobId !== jobId) return undefined;
  return parseJobSummary(memory.content);
}

export async function saveJobSummary(
  db: DrizzleDb,
  personaId: string,
  jobId: string,
  summary: ThreadSummary,
): Promise<void> {
  await rememberJobSummaryMemory(db, {
    personaId,
    jobId,
    content: formatJobSummary(summary),
    importance: 0,
  });
}
