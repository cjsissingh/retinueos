import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { runMigrations } from "../../src/db/migrate.js";
import type { GlobalSetupContext } from "vitest/node";

// One Postgres *database* per vitest worker, not one shared database across
// the whole run: with file parallelism on, worker A's afterEach TRUNCATE
// would otherwise race worker B's mid-file assertions on the same rows.
// 81bf1ec0 fixed that race by serializing all test files onto one worker
// (fileParallelism: false) -- correct, but it turned the suite into one long
// queue. Scoping TRUNCATE to a per-worker database lets files run in
// parallel again without reintroducing the race. Keep this in sync with
// `maxWorkers` in vitest.config.ts -- more workers than databases means two
// workers would share a database and the old race comes back.
const WORKER_COUNT = 2;

let container: StartedPostgreSqlContainer | undefined;

async function createWorkerDatabases(adminUrl: string): Promise<string[]> {
  const baseDbName = new URL(adminUrl).pathname.replace(/^\//, "");
  const admin = postgres(adminUrl, { max: 1 });
  try {
    const urls: string[] = [];
    for (let i = 1; i <= WORKER_COUNT; i++) {
      const dbName = `${baseDbName}_w${i}`;
      // No `CREATE DATABASE IF NOT EXISTS` in Postgres -- check first so a
      // rerun against a persistent server (the LOCAL_TEST_DATABASE_URL
      // escape hatch, where the server outlives any one `vitest run`)
      // doesn't fail on a database a prior run already created.
      const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
      if (exists.length === 0) {
        // One at a time: concurrent `CREATE DATABASE` calls contend on the
        // template database's lock and fail with "source database
        // "template1" is being accessed by other users".
        await admin.unsafe(`CREATE DATABASE ${dbName}`);
      }
      // TRUNCATE ... CASCADE prints a NOTICE per cascaded table, and
      // afterEach in useTestDb runs one every test -- thousands of lines of
      // noise over a full run, all forwarded from worker to main process.
      // Silencing at the database level (not via `onnotice` in
      // src/db/client.ts) keeps that log level a test-only default rather
      // than an app-wide behavior change.
      await admin.unsafe(`ALTER DATABASE ${dbName} SET client_min_messages = warning`);
      const url = new URL(adminUrl);
      url.pathname = `/${dbName}`;
      urls.push(url.toString());
    }
    return urls;
  } finally {
    await admin.end();
  }
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  process.env.AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? "test-password";
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-anthropic-key";

  // Escape hatch for environments without a Docker daemon (no
  // /var/run/docker.sock -- testcontainers can't start a container there):
  // point this at any reachable, disposable Postgres and skip
  // testcontainers entirely. CI and normal local dev don't set this, so the
  // testcontainers path below is still what actually runs by default.
  const local = process.env.LOCAL_TEST_DATABASE_URL;
  let adminUrl: string;
  if (local) {
    adminUrl = local;
  } else {
    container = await new PostgreSqlContainer("postgres:16").start();
    adminUrl = container.getConnectionUri();
  }

  const urls = await createWorkerDatabases(adminUrl);
  await Promise.all(urls.map((url) => runMigrations(url)));
  provide("testDatabaseUrls", urls);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrls: string[];
  }
}
