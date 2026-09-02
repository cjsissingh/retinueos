import { inject } from "vitest";

// Several tests reach for process.env.DATABASE_URL directly (getSettings(),
// checkpointer setup, migrate.ts) rather than going through useTestDb(), so
// it has to be set for real, not just handed to useTestDb() via inject().
// global-setup.ts provisions one database per worker and hands the list
// over via inject(); this setup file (one per test file, inside the
// worker) resolves this worker's share of that list using VITEST_POOL_ID,
// which is 1-indexed and stable for the worker's lifetime.
const urls = inject("testDatabaseUrls");
const poolId = Number(process.env.VITEST_POOL_ID ?? "1");
const url = urls[(poolId - 1) % urls.length];
if (!url) throw new Error(`no test database provisioned for pool id ${poolId}`);
process.env.DATABASE_URL = url;
