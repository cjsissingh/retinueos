import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb } from "./db/client.js";
import type { DrizzleDb } from "./db/client.js";
import { getSettings } from "./config.js";
import { configRoutes } from "./config-routes.js";
import { modelRoutes } from "./models/model-routes.js";
import { modelCallRoutes } from "./models/model-call-routes.js";
import { personaRoutes } from "./personas/persona-routes.js";
import { personaMemoryRoutes } from "./personas/persona-memory-routes.js";
import { personaStateRoutes } from "./personas/persona-state-routes.js";
import { routineRoutes } from "./personas/routine-routes.js";
import { jobRoutes } from "./jobs/job-routes.js";
import { toolCallRoutes } from "./tool-calls/tool-call-routes.js";
import { notificationRoutes } from "./notifications/notification-routes.js";
import { credentialRoutes } from "./tools/credential-routes.js";
import { mcpRoutes } from "./tools/mcp-routes.js";
import { customToolRoutes } from "./tools/custom-tool-routes.js";
import { streamRoutes } from "./stream/stream-routes.js";
import { defaultJobEventBus } from "./orchestration/event-bus.js";
import type { PersonaScheduler } from "./orchestration/scheduler.js";
import type { JobWorker } from "./orchestration/job-worker.js";
import { requireAuth, type ControlClientEnv } from "./auth/middleware.js";
import { createControlPlane, type ControlPlane } from "./control/control-plane.js";
import { auditRoutes } from "./control/audit-routes.js";
import { controlClientRoutes } from "./control/client-routes.js";
import { controlMcpRoutes } from "./control/mcp-server.js";

/**
 * `scheduler` is optional and, when passed (server.ts always passes its
 * real one), lets a newly created routine start firing immediately instead
 * of waiting for the next process restart to be picked up by registerAll.
 */
export function createApp(
  scheduler?: PersonaScheduler,
  injectedDb?: DrizzleDb,
  worker?: Pick<JobWorker, "abortAttempt">,
  controlPlane?: ControlPlane,
): Hono<ControlClientEnv> {
  const app = new Hono<ControlClientEnv>();
  const settings = getSettings();
  const db = injectedDb ?? createDb(settings.databaseUrl);
  const controls = {
    abortAttempt: (attemptId: string) => worker?.abortAttempt(attemptId),
    publishStatus: (jobId: string, status: string) => defaultJobEventBus.publish(jobId, { type: "status", status }),
  };
  const plane = controlPlane ?? createControlPlane({ db, settings, scheduler, jobControls: controls });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.use(
    "*",
    cors({
      origin: settings.frontendOrigin,
      allowHeaders: [
        "X-Auth-Password",
        "Authorization",
        "content-type",
        "Mcp-Method",
        "Mcp-Name",
        "Mcp-Protocol-Version",
        "Mcp-Session-Id",
        "Mcp-Request-Id",
        "Mcp-Request-State",
        "Mcp-Stream-Id",
        "Last-Event-ID",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.use("/personas/*", requireAuth());
  app.use("/personas", requireAuth());
  app.use("/routines/*", requireAuth());
  app.use("/routines", requireAuth());
  app.use("/jobs/*", requireAuth());
  app.use("/jobs", requireAuth());
  app.use("/tool_calls/*", requireAuth());
  app.use("/tool_calls", requireAuth());
  app.use("/pending_approvals/*", requireAuth());
  app.use("/pending_approvals", requireAuth());
  app.use("/notifications/*", requireAuth());
  app.use("/notifications", requireAuth());
  app.use("/push/*", requireAuth());
  app.use("/digests/*", requireAuth());
  app.use("/digests", requireAuth());
  app.use("/credentials/*", requireAuth());
  app.use("/custom-tools/*", requireAuth());
  app.use("/custom-tools", requireAuth());
  app.use("/mcp/*", async (c, next) => {
    if (c.req.path === "/mcp/control" || c.req.path.startsWith("/mcp/control/")) return next();
    return requireAuth()(c, next);
  });
  app.use("/config", requireAuth());
  app.use("/models", requireAuth());
  app.use("/control/*", requireAuth());
  app.use("/control", requireAuth());

  app.route("/", configRoutes());
  app.route("/", modelRoutes());
  app.route("/personas", personaRoutes(db, plane.personas));
  app.route("/", personaMemoryRoutes(db));
  app.route("/", personaStateRoutes(db));
  app.route("/", modelCallRoutes(db));
  app.route("/", routineRoutes(plane.routines));
  app.route("/jobs", jobRoutes(db, undefined, controls, plane.jobs));
  app.route("/tool_calls", toolCallRoutes(db, undefined, plane.approvals));
  app.route("/control/audit", auditRoutes(plane.audit));
  app.route("/control/clients", controlClientRoutes(db));
  app.route("/mcp/control", controlMcpRoutes(plane, db));
  app.route("/", notificationRoutes(db));
  app.route("/", credentialRoutes(db));
  app.route("/", mcpRoutes(db));
  app.route("/", customToolRoutes(db));
  app.route("/", streamRoutes(db, defaultJobEventBus));

  return app;
}
