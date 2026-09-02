// backend/src/db/client.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  // idle_timeout/max_lifetime: postgres.js's default idle_timeout is `null`
  // (never close an idle connection), which is exactly wrong against a
  // serverless Postgres that can suspend its compute after a period of
  // inactivity (e.g. Neon's default ~5min autosuspend) — a socket left open
  // across that boundary goes stale, and queries over it fail with
  // confusing "relation does not exist" errors rather than a clean
  // connection error. Recycling idle connections well inside that window,
  // plus an outer max_lifetime as a backstop against any other cause of a
  // connection going bad, means the pool always reconnects instead of
  // reusing a zombie socket.
  const client = postgres(databaseUrl, { max: 10, idle_timeout: 20, max_lifetime: 60 * 30 });
  return drizzle(client, { schema });
}

export type DrizzleDb = ReturnType<typeof createDb>;
