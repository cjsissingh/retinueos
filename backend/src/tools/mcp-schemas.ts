import { z } from "zod";
import { parseRemoteMcpUrl } from "./mcp-url.js";

const RemoteMcpUrlSchema = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    try {
      parseRemoteMcpUrl(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "invalid remote MCP URL",
      });
    }
  });

// The authorization endpoint is only ever used to build a URL the
// *browser* navigates to (mcp-oauth.ts's buildAuthorizeUrl) — it's never
// fetched server-side, so it doesn't need RemoteMcpUrlSchema's SSRF/DNS-
// rebinding checks, just a well-formed-HTTPS check so a malformed value
// fails at add-server time instead of producing a broken redirect later.
const AuthorizationEndpointSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", { message: "authorization endpoint must use HTTPS" });

const BearerServerCreateSchema = z.object({
  authType: z.literal("bearer"),
  name: z.string().min(1),
  url: RemoteMcpUrlSchema,
  bearerToken: z.string().min(1).optional(),
});

// The token endpoint IS fetched server-side (mcp-oauth.ts's exchange/
// refresh calls), so it goes through the same SSRF-hardened validation as
// an MCP server's own URL.
const OAuthServerCreateSchema = z.object({
  authType: z.literal("oauth"),
  name: z.string().min(1),
  url: RemoteMcpUrlSchema,
  oauthClientId: z.string().min(1),
  oauthClientSecret: z.string().min(1),
  oauthAuthorizationEndpoint: AuthorizationEndpointSchema,
  oauthTokenEndpoint: RemoteMcpUrlSchema,
  oauthScope: z.string().min(1),
});

// authType defaults to "bearer" when omitted — every server created
// before OAuth support existed (and every pre-existing test) posts
// without it.
export const McpServerCreateSchema = z.preprocess(
  (value) => (value && typeof value === "object" && !("authType" in value) ? { ...value, authType: "bearer" } : value),
  z.discriminatedUnion("authType", [BearerServerCreateSchema, OAuthServerCreateSchema]),
);

// url/bearerToken are both optional so a PATCH can rotate either (or just
// toggle `enabled`) without having to resend everything — and, more
// importantly, without going through DELETE + re-create, which cascades and
// destroys every human-set tool approval (see mcp-server-repo.ts's
// updateMcpServer doc comment).
export const McpServerUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: RemoteMcpUrlSchema.optional(),
    bearerToken: z.string().min(1).optional(),
  })
  .refine((data) => data.enabled !== undefined || data.url !== undefined || data.bearerToken !== undefined, {
    message: "at least one of enabled, url, or bearerToken must be provided",
  });

// riskClass/approved are both optional individually (a PATCH can set just
// one), but setting approved: true requires riskClass to be present either
// in this same request or already stored — enforced in the route, not here,
// since that check needs the existing row's state, not just this body.
export const McpServerToolUpdateSchema = z
  .object({
    riskClass: z.enum(["read_only", "reversible", "destructive"]).optional(),
    approved: z.boolean().optional(),
  })
  .refine((data) => data.riskClass !== undefined || data.approved !== undefined, {
    message: "at least one of riskClass or approved must be provided",
  });
