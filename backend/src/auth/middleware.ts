import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getSettings } from "../config.js";
import type { DrizzleDb } from "../db/client.js";
import type { ControlClientRow } from "../db/schema.js";
import { authenticateControlToken } from "../control/client-repo.js";

export interface ControlClientEnv {
  Variables: {
    controlClient: ControlClientRow;
  };
}

// Comparing the provided password to the configured one with `!==` leaks
// timing information proportional to how many leading characters match,
// letting an attacker recover the password byte-by-byte. Hash both sides
// first (fixed-length digests sidestep the length check that a naive
// `timingSafeEqual(a, b)` would otherwise need, which itself branches on
// length) and compare the digests in constant time.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function passwordsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header("X-Auth-Password") ?? c.req.query("password") ?? "";
    if (!passwordsMatch(provided, getSettings().authPassword)) {
      return c.json({ error: "invalid or missing X-Auth-Password header" }, 401);
    }
    await next();
  };
}

/** Authenticates only named control-client bearer tokens for the MCP control endpoint. */
export function requireControlClient(db: DrizzleDb): MiddlewareHandler<ControlClientEnv> {
  return async (c, next) => {
    const query = new URL(c.req.url).searchParams;
    if (["token", "access_token", "password"].some((name) => query.has(name))) {
      return c.json({ error: "credentials are not accepted in query parameters" }, 401);
    }

    const authorization = c.req.header("Authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) return c.json({ error: "invalid or missing bearer token" }, 401);

    const client = await authenticateControlToken(db, match[1]);
    if (!client) return c.json({ error: "invalid or missing bearer token" }, 401);

    c.set("controlClient", client);
    await next();
  };
}
