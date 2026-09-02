import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { ControlAuditService } from "../src/control/audit-service.js";
import { auditRoutes } from "../src/control/audit-routes.js";
import { createControlAuditEvent } from "../src/control/control-repo.js";

const { db } = useTestDb();
const owner = { kind: "owner", source: "rest" } as const;
const noAuditScope = { kind: "mcp_client", clientId: "not-an-auditor", scopes: ["jobs:read"] } as const;

function buildApp() {
  const app = new Hono();
  app.route("/control/audit", auditRoutes(new ControlAuditService(db())));
  return app;
}

describe("ControlAuditService", () => {
  it("permits owners but requires audit read scope from MCP clients", async () => {
    const service = new ControlAuditService(db());

    await expect(service.list(noAuditScope, { limit: 50 })).rejects.toMatchObject({ category: "insufficient_scope" });
    await expect(service.list(owner, { limit: 50 })).resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe("GET /control/audit", () => {
  it("filters owner audit queries by actor, action, target type, and outcome", async () => {
    await createControlAuditEvent(db(), {
      actor: owner,
      action: "approval.approve",
      targetType: "tool_call",
      targetId: "matching-call",
      outcome: "succeeded",
    });
    await createControlAuditEvent(db(), {
      actor: { kind: "mcp_client", clientId: "other", scopes: ["approvals:write"] },
      action: "approval.reject",
      targetType: "tool_call",
      targetId: "other-call",
      outcome: "failed",
    });

    const res = await buildApp().request(
      "/control/audit?actorKind=owner&actorId=rest&action=approval.approve&targetType=tool_call&outcome=succeeded",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [expect.objectContaining({ targetId: "matching-call", action: "approval.approve" })],
      nextCursor: null,
    });
  });

  it("returns audit records in stable descending cursor pages and caps the limit", async () => {
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        createControlAuditEvent(db(), {
          actor: owner,
          action: "job.create",
          targetType: "job",
          targetId: `job-${index}`,
          outcome: "succeeded",
        }),
      ),
    );
    const app = buildApp();

    const capped = await app.request("/control/audit?limit=500");
    const first = await app.request("/control/audit?limit=2");
    const firstPage = await first.json();
    const second = await app.request(`/control/audit?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    const secondPage = await second.json();

    expect((await capped.json()).items).toHaveLength(100);
    expect(firstPage.items).toHaveLength(2);
    expect(secondPage.items).toHaveLength(2);
    expect(new Set([...firstPage.items, ...secondPage.items].map((event: { id: string }) => event.id)).size).toBe(4);
  });
});
