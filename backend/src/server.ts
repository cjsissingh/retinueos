import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { getSettings } from "./config.js";
import { makeCheckpointer } from "./graph/checkpointer.js";
import { listRoutines } from "./personas/routine-repo.js";
import { defaultRegistry } from "./tools/registry.js";
import { registerBuiltinTools } from "./tools/builtin.js";
import { registerAllApprovedMcpTools } from "./tools/mcp-registration.js";
import { PersonaScheduler } from "./orchestration/scheduler.js";
import { JobWorker } from "./orchestration/job-worker.js";
import { defaultJobEventBus } from "./orchestration/event-bus.js";
import { createControlPlane } from "./control/control-plane.js";

const settings = getSettings();
const db = createDb(settings.databaseUrl);
const checkpointer = makeCheckpointer(settings.databaseUrl);
await checkpointer.setup();

// Every published JobEvent gets durably logged to job_events from here on,
// letting stream-routes.ts replay a job's recent activity on reconnect
// instead of only ever showing whatever arrives after the new connection is
// established. See event-bus.ts's setPersistence doc comment.
defaultJobEventBus.setPersistence(db);

const scheduler = new PersonaScheduler(db, defaultRegistry, checkpointer);
const controlPlane = createControlPlane({
  db,
  settings,
  scheduler,
  jobControls: {
    abortAttempt: (attemptId) => worker.abortAttempt(attemptId),
    publishStatus: (jobId, status) => defaultJobEventBus.publish(jobId, { type: "status", status }),
  },
});
registerBuiltinTools(defaultRegistry, {
  routineService: controlPlane.routines,
  webSearchApiKey: settings.webSearchApiKey,
});

// Remote MCP tools already approved in a previous process become live on
// the same registry as native tools. See
// docs/adr/0002-external-tools-via-mcp-adapters.md. mcp-routes.ts's PATCH
// .../tools/:toolId re-registers a single tool the moment a human approves
// it, so a freshly approved tool doesn't need a process restart — this
// startup pass only needs to catch up on what was already approved before
// this process started.
await registerAllApprovedMcpTools(db, defaultRegistry);

const worker = new JobWorker({ db, registry: defaultRegistry, checkpointer });
worker.start();

scheduler.registerAll(await listRoutines(db));
scheduler.start();

const app = createApp(scheduler, db, worker, controlPlane);
const port = Number(process.env.PORT ?? 8080);

const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`retinueos-backend listening on port ${info.port}`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}; draining job worker`);
  const closingServer = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  const forceClose = setTimeout(() => {
    console.warn("forcing lingering HTTP connections closed during shutdown");
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  }, 5_000);
  forceClose.unref();
  scheduler.stop();
  worker.stop();
  await Promise.all([closingServer, scheduler.drain(), worker.drain()]);
  clearTimeout(forceClose);
  await checkpointer.end?.();
  await db.$client.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("graceful shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}
