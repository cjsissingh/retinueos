import { beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type DrizzleDb } from "../../src/db/client.js";
import { RoutineService } from "../../src/control/routine-service.js";
import { registerBuiltinTools } from "../../src/tools/builtin.js";
import { defaultRegistry } from "../../src/tools/registry.js";

// Tables @langchain/langgraph-checkpoint-postgres creates lazily (only once
// some test calls checkpointer.setup(), e.g. persona-graph.test.ts /
// checkpointer.test.ts) — never migrated up front like the app's own
// schema, so they can't just be added to the TRUNCATE list below: on a run
// where nothing has created them yet, TRUNCATE-ing a nonexistent table
// would fail the *next* test's setup, not just skip cleanup.
const CHECKPOINT_TABLES = ["checkpoints", "checkpoint_blobs", "checkpoint_writes"];

export function useTestDb() {
  let db: DrizzleDb;

  // One pool per file, not per test: opening/closing a postgres-js pool
  // (TCP connect + auth) ~609 times across the suite showed up as real time
  // in profiling. TRUNCATE in afterEach below is what gives tests their
  // isolation from each other -- the pool itself is stateless and safe to
  // share across every test in a file.
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // Re-registering every test (not just once per file in beforeAll above)
  // keeps this file's tests order-independent from each other -- a test
  // that unregisters/revokes a tool on the shared defaultRegistry shouldn't
  // leak that into the next test in the same file.
  beforeEach(() => {
    registerBuiltinTools(defaultRegistry, { routineService: new RoutineService(db) });
  });

  afterEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE control_operations, control_audit_events, control_clients, notification_deliveries, notification_preferences, notification_quiet_hours, push_subscriptions, job_attempts, tool_calls, digests, notifications, credentials, custom_tool_proposals, mcp_server_tools, mcp_servers, persona_state, persona_memories, jobs, routines, personas RESTART IDENTITY CASCADE`,
    );
    // Left un-truncated, checkpointed graph state from one test outlives it
    // and can be replayed into a later test that reuses the same
    // thread_id — normally invisible, because testcontainers hands every
    // `vitest run` a brand-new empty database, but a real leak against the
    // LOCAL_TEST_DATABASE_URL escape hatch (tests/setup/global-setup.ts),
    // where the same Postgres persists across runs.
    // `= ANY(${array})` binds the JS array as a single parameter, which the
    // postgres-js driver does not serialize as a Postgres array literal —
    // it fails every call with "op ANY/ALL (array) requires array on right
    // side". An `IN (...)` list of individually-bound scalars sidesteps
    // that; each table name still passes through as a bound parameter, not
    // string-interpolated SQL.
    const nameList = sql.join(
      CHECKPOINT_TABLES.map((name) => sql`${name}`),
      sql`, `,
    );
    const existing = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${nameList})`,
    );
    if (existing.length > 0) {
      const names = existing.map((row) => sql.identifier(row.table_name));
      await db.execute(sql`TRUNCATE TABLE ${sql.join(names, sql.raw(", "))} CASCADE`);
    }
  });

  return { db: () => db };
}
