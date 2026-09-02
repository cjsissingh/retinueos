// backend/src/config-routes.ts
//
// Exposes the parts of Settings the frontend actually needs to make sane
// choices in the UI — which model providers have an API key configured, and
// whether that's *any* provider at all. Without this, the persona-creation
// form's provider dropdown (frontend/components/add-employee-form.tsx) had
// no way to know that, say, OPENAI_API_KEY was never set: a user could pick
// "openai" there, hire the persona successfully, and only find out it's
// broken the first time a job for it fails — the model SDK rejecting the
// call for a missing key, deep in that job's logs, with nothing pointing
// back at persona setup. `ready` is the coarser, app-wide version of the
// same problem: with zero provider keys configured, nothing in the app can
// ever do anything, so AppShell polls this and blocks the whole app behind
// setup instructions (components/setup-required.tsx) instead of letting you
// hire personas and dispatch jobs that are certain to fail.
import { Hono } from "hono";
import { getSettings } from "./config.js";

export function configRoutes(): Hono {
  const app = new Hono();

  app.get("/config", (c) => {
    const { availableProviders, webSearchApiKey } = getSettings();
    return c.json({
      availableProviders,
      ready: availableProviders.length > 0,
      webSearchAvailable: webSearchApiKey !== undefined,
    });
  });

  return app;
}
