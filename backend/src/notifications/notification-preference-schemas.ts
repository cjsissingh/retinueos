import { z } from "zod";

export const NotificationKindSchema = z.enum([
  "approval_needed",
  "question",
  "job_finished",
  "job_failed",
  "routine_ran",
  "connector_broke",
]);

export const NotificationPreferenceUpdateSchema = z
  .object({
    inAppEnabled: z.boolean().optional(),
    pushEnabled: z.boolean().optional(),
    digestEnabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "at least one field must be provided" });

export const QuietHoursUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    startMinute: z.number().int().min(0).max(1439).optional(),
    endMinute: z.number().int().min(0).max(1439).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "at least one field must be provided" });
