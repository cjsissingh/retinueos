import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

export function makeCheckpointer(databaseUrl: string): PostgresSaver {
  // Explicit Pool (rather than PostgresSaver.fromConnString's default one)
  // so idleTimeoutMillis is guaranteed rather than relying on pg's default
  // — see the matching comment in db/client.ts on why a long-lived pool
  // must recycle idle connections against a serverless Postgres that can
  // suspend its compute (e.g. Neon's autosuspend). pg's own default
  // (10000ms) already does this, but setting it explicitly keeps both of
  // this app's Postgres pools governed by the same documented policy
  // instead of one of them depending on an undocumented library default.
  const pool = new pg.Pool({ connectionString: databaseUrl, idleTimeoutMillis: 20_000, max: 10 });
  return new PostgresSaver(pool);
}
