// backend/src/models/model-routes.ts
//
// GET /models — the live model lineup for every provider with an API key
// configured (see config.ts's availableProviders), fetched from each
// provider's own API and cached briefly (model-catalog.ts). Backs the
// frontend's model picker: a dropdown of what's actually callable right
// now, not a free-text field a typo can silently break.
import { Hono } from "hono";
import { getSettings } from "../config.js";
import { fetchAvailableModels } from "./model-catalog.js";

export function modelRoutes(): Hono {
  const app = new Hono();

  app.get("/models", async (c) => {
    const { availableProviders } = getSettings();
    const models = await fetchAvailableModels(availableProviders);
    return c.json({ models });
  });

  return app;
}
