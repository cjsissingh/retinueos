import { z } from "zod";

const CONTROL_SCOPES = [
  "personas:read",
  "jobs:read",
  "jobs:write",
  "routines:read",
  "routines:write",
  "approvals:read",
  "approvals:write",
  "audit:read",
] as const;

const ControlScopeSchema = z.enum(CONTROL_SCOPES);

export const ControlClientCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    scopes: z.array(ControlScopeSchema).min(1),
  })
  .strict();

export type ControlClientCreateInput = z.infer<typeof ControlClientCreateSchema>;
