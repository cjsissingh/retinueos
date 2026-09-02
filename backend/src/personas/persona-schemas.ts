import { z } from "zod";

// Allow / Ask are stored on the assigned-tool row. Blocked is omitting the
// tool from the array. `autonomy: "approval_required"` is the legacy Ask
// alias — see AssignedToolConfig in db/schema.ts. There is still no
// "direct" autonomy value that could weaken a destructive tool: Allow on a
// destructive tool is coerced to Ask at write time (tools/autonomy.ts) and
// gated at runtime regardless of what was stored.
const AssignedToolConfigSchema = z.object({
  toolId: z.string().min(1),
  permission: z.enum(["allow", "ask"]).optional(),
  autonomy: z.enum(["approval_required"]).optional(),
});

export const PersonaCreateSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string().min(1),
  voiceNotes: z.string().default(""),
  boundaries: z.string().default(""),
  scopeDescription: z.string().default(""),
  modelProvider: z.string().min(1),
  modelName: z.string().min(1),
  assignedToolIds: z.array(AssignedToolConfigSchema).default([]),
  // Org chart: who this persona reports to. Optional/nullable — omitting it
  // (or passing null) makes this a top-of-chart persona. A new persona can
  // only ever be given an *existing* persona's id here (its own id doesn't
  // exist yet at create time), so a cycle can never originate from create —
  // only reassignment (PersonaUpdateSchema, below) needs the cycle check.
  reportsTo: z.string().uuid().nullable().optional(),
});

export type PersonaCreateInput = z.infer<typeof PersonaCreateSchema>;

// Mutates a persona after hiring. Deliberately general-purpose: a persona's
// role, tools, and even personality are expected to evolve as the tools and
// systems around it evolve, so almost everything here is patchable, not just
// org chart/model. All fields optional and merged onto the existing row — a
// PATCH only touches what it includes, so e.g. fixing modelName doesn't
// require also resending reportsTo or systemPrompt. The one thing that
// can't change is `id`, which isn't a field here at all.
//
// assignedToolIds is a full-array replace, same as create — there's no
// partial "add one tool" shape. Destructive Allow is coerced to Ask on
// write (normalizeAssignedTools) and gated at runtime regardless, so
// replacing the whole array can't be used to smuggle in weaker gating.
export const PersonaUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  voiceNotes: z.string().optional(),
  boundaries: z.string().optional(),
  scopeDescription: z.string().optional(),
  assignedToolIds: z.array(AssignedToolConfigSchema).optional(),
  // Org chart: who this persona reports to. See PersonaCreateSchema's own
  // comment — reassignment is the one place a cycle can originate, hence
  // the cycle check in persona-routes.ts.
  reportsTo: z.string().uuid().nullable().optional(),
  modelProvider: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
});

export type PersonaUpdateInput = z.infer<typeof PersonaUpdateSchema>;
