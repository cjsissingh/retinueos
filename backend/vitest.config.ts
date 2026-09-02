import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/global-setup.ts"],
    setupFiles: ["./tests/setup/set-database-url.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each worker gets its own Postgres database (see global-setup.ts /
    // useTestDb) so files no longer need to be serialized to avoid one
    // file's afterEach TRUNCATE racing another's assertions -- that used to
    // be handled by fileParallelism: false (81bf1ec0), which correctly
    // avoided the race but made the whole suite one long queue. Keep
    // maxWorkers in sync with WORKER_COUNT in global-setup.ts: more workers
    // than databases means workers share a database and the old race comes
    // back. Two workers avoid oversubscribing typical CI runners while the
    // Postgres service container competes for the same CPU allocation.
    minWorkers: 1,
    maxWorkers: 2,
  },
});
