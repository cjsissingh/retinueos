import { z } from "zod";

const JobPromptSchema = z
  .string()
  .min(1)
  .refine((prompt) => prompt.trim().length > 0, { message: "prompt must contain non-whitespace characters" });

export const JobCreateSchema = z.object({
  personaId: z.string().uuid(),
  prompt: JobPromptSchema,
  notifyOnOutcome: z.boolean().default(false),
});

export type JobCreateInput = z.infer<typeof JobCreateSchema>;

export const JobContinueSchema = z.object({
  prompt: JobPromptSchema,
  notifyOnOutcome: z.boolean().default(false),
});

export type JobContinueInput = z.infer<typeof JobContinueSchema>;
