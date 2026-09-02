import { z } from "zod";

/** POST /personas/generate. A freeform description, optionally
 *  anchored to one of the starter templates as a starting point (the
 *  "canned persona types" the ticket describes). */
export const PersonaGenerateRequestSchema = z.object({
  description: z.string().min(1),
  seedTemplateSlug: z.string().optional(),
});

const GeneratedDraftToolSchema = z.object({
  toolId: z.string().min(1),
  permission: z.enum(["allow", "ask"]).optional(),
});

/**
 * Shape of the LLM's structured output. Mirrors StarterPersonaTemplate
 * (minus `slug`) so the frontend can prefill PersonaForm the same way it
 * does from a static template — a generated draft is just a one-off
 * template of one. `defaultTools` is validated against the live tool
 * registry by the route handler, not trusted as-is from the model.
 */
export const PersonaGeneratedDraftSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string().min(1),
  voiceNotes: z.string().default(""),
  boundaries: z.string().default(""),
  scopeDescription: z.string().default(""),
  defaultTools: z.array(GeneratedDraftToolSchema).default([]),
});
