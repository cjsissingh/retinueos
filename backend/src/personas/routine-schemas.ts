import { z } from "zod";
import cron from "node-cron";

export const RoutineCreateSchema = z
  .object({
    name: z.string().min(1),
    cronSchedule: z.string().min(1),
    promptTemplate: z.string().min(1),
    notifyRoutineRan: z.boolean().default(false),
    // "job" (default) seeds a normal chat job; "digest" calls
    // generateDigest directly instead and never creates a jobs row.
    // promptTemplate stays required either way (kept simple on purpose --
    // see routine-repo.ts) and is simply ignored for a digest routine.
    kind: z.enum(["job", "digest"]).default("job"),
  })
  .refine((data) => cron.validate(data.cronSchedule), {
    message: "cronSchedule is not a valid cron expression",
    path: ["cronSchedule"],
  });

export type RoutineCreateInput = z.infer<typeof RoutineCreateSchema>;

// Every field optional (a PATCH-style partial update), but at least one of
// them must actually be present -- an empty body is almost certainly a bug
// on the caller's end, not "update nothing." cronSchedule is only validated
// against node-cron's own rules when it's actually being changed; omitting
// it entirely (leaving the existing schedule alone) must not fail this
// refinement just because `undefined` isn't a valid cron expression.
export const RoutineUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    cronSchedule: z.string().min(1).optional(),
    promptTemplate: z.string().min(1).optional(),
    notifyRoutineRan: z.boolean().optional(),
    enabled: z.boolean().optional(),
    kind: z.enum(["job", "digest"]).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "at least one field must be provided" })
  .refine((data) => data.cronSchedule === undefined || cron.validate(data.cronSchedule), {
    message: "cronSchedule is not a valid cron expression",
    path: ["cronSchedule"],
  });

export type RoutineUpdateInput = z.infer<typeof RoutineUpdateSchema>;
