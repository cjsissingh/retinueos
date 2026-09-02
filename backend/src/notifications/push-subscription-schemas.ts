import { z } from "zod";

const PushEndpointSchema = z
  .string()
  .min(1)
  .max(4_096)
  .url()
  .refine((endpoint) => new URL(endpoint).protocol === "https:", {
    message: "push subscription endpoint must use HTTPS",
  });

export const PushSubscriptionSchema = z.object({
  endpoint: PushEndpointSchema,
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

export const PushSubscriptionDeleteSchema = z.object({ endpoint: PushEndpointSchema });
