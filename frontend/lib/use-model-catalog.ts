import { useEffect, useState } from "react";
import type { ApiClient } from "./api-client";

/**
 * Live per-provider model lists (GET /models), for PersonaForm's model
 * picker dropdown (shared by hiring and editing a persona — one form, one
 * fetch-on-mount behavior to reason about). `null` means "haven't heard
 * back yet", distinct from `{}` (heard back, nothing configured) so the
 * picker doesn't flash "no models" before this resolves.
 */
export function useModelCatalog(client: ApiClient): Record<string, string[]> | null {
  const [models, setModels] = useState<Record<string, string[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getModels()
      .then(({ models: fetched }) => {
        if (!cancelled) setModels(fetched);
      })
      .catch(() => {
        // Couldn't fetch the live list -- leave it at null rather than
        // blocking the picker over a transient failure of an endpoint this
        // form only uses to populate a dropdown.
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return models;
}
