import type { Persona } from "./api-client";

// The overlay/dialog chrome (backdrop, sizing, corners, Esc, scroll lock)
// used to live here as bespoke class strings -- now the Sheet primitive
// supplies all of that, so this only carries the picker's own
// content layout.
export const ASK_LAYOUT = {
  personaChips: "mb-4.5 hidden flex-wrap gap-2 md:flex",
  personaSelect: "mb-4.5 w-full rounded-button border px-3 py-2.5 font-sans text-base outline-none md:hidden",
} as const;

/**
 * Top-of-chart persona in the same sense as the org chart: no manager, a
 * self-report, or an orphaned `reportsTo`. When several roots exist, pick
 * the one with the most direct reports — the Principal in the common case —
 * not `personas[0]` and not last-used.
 */
export function primaryPersonaId(personas: Persona[]): string | null {
  if (personas.length === 0) return null;
  const ids = new Set(personas.map((p) => p.id));
  const roots = personas.filter((p) => !p.reportsTo || p.reportsTo === p.id || !ids.has(p.reportsTo));
  const pool = roots.length > 0 ? roots : personas;
  const reportCount = (id: string) => personas.filter((p) => p.reportsTo === id).length;
  return pool.reduce((best, p) => (reportCount(p.id) > reportCount(best.id) ? p : best)).id;
}

/** Seed prompt/persona only on the closed→open transition, never when the
 *  roster array identity changes from the shell's 15s poll. */
export function shouldSeedAskDraft(open: boolean, previouslyOpen: boolean): boolean {
  return open && !previouslyOpen;
}

export function personasForAskPicker(personas: Persona[]): Persona[] {
  const primary = primaryPersonaId(personas);
  if (!primary) return personas;
  const lead = personas.find((p) => p.id === primary);
  if (!lead) return personas;
  return [lead, ...personas.filter((p) => p.id !== primary)];
}
