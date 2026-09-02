import type { DrizzleDb } from "../db/client.js";
import { jobs, type JobRow } from "../db/schema.js";

const MAX_DEPTH = 3;
const MAX_DESCENDANTS = 10;

export async function checkDelegationAllowed(
  db: DrizzleDb,
  parentJob: JobRow,
): Promise<{ allowed: boolean; reason?: string }> {
  if (parentJob.depth >= MAX_DEPTH) {
    return { allowed: false, reason: `delegation depth limit reached (${MAX_DEPTH})` };
  }

  let rootId = parentJob.id;
  let cursor: JobRow | undefined = parentJob;
  const all: JobRow[] = await db.select().from(jobs);
  const byId = new Map(all.map((j) => [j.id, j]));
  while (cursor?.parentJobId) {
    cursor = byId.get(cursor.parentJobId);
    if (cursor) rootId = cursor.id;
  }

  let descendants = 0;
  for (const j of all) {
    let node: JobRow | undefined = j;
    while (node?.parentJobId) {
      if (node.parentJobId === rootId) {
        descendants += 1;
        break;
      }
      node = byId.get(node.parentJobId);
    }
  }

  if (descendants >= MAX_DESCENDANTS) {
    return { allowed: false, reason: `delegation descendant limit reached (${MAX_DESCENDANTS})` };
  }

  return { allowed: true };
}
