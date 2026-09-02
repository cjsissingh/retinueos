import { z } from "zod";

// toolKey becomes the eventual ToolSpec.id — constrained to what
// registry.ts's allocateModelName treats as safe-as-is
// (/^[A-Za-z0-9_-]{1,64}$/), narrowed to a lowercase-starting slug so a
// value typed here never needs silent renaming later.
const ToolKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,62}$/,
    "must start with a lowercase letter and contain only lowercase letters, digits, - or _ (max 63 chars)",
  );

const LimitsSchema = z.object({
  timeoutMs: z.number().int().positive(),
  memoryMb: z.number().int().positive(),
  maxOutputBytes: z.number().int().positive(),
});

const CustomToolProposalBodySchema = z.object({
  description: z.string().min(1),
  source: z.string().min(1),
  parametersSchema: z.record(z.unknown()),
  hostAllowList: z.array(z.string().min(1)).default([]),
  secretRefs: z.array(z.string().min(1)).default([]),
  limits: LimitsSchema,
  suggestedRiskClass: z.enum(["read_only", "reversible", "destructive"]),
});

export const CustomToolCreateSchema = CustomToolProposalBodySchema.extend({
  toolKey: ToolKeySchema,
});

export const CustomToolVersionCreateSchema = CustomToolProposalBodySchema;

export const CustomToolReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reviewNote: z.string().min(1).optional(),
});
