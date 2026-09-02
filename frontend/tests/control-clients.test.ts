import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, type ControlClientPage } from "../lib/api-client.js";
import {
  controlMcpUrl,
  groupControlScopes,
  isControlClientPage,
  mergeClientsAfterStaleLoad,
  pairReadScopesWithWrites,
  scopeLabel,
} from "../app/settings/access/access-settings-content";

const clientPage: ControlClientPage = {
  items: [
    {
      id: "client-1",
      name: "Desktop client",
      tokenPrefix: "prefix-one",
      scopes: ["jobs:read", "jobs:write"],
      createdAt: "2026-08-26T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    },
  ],
  nextCursor: "next-page",
};

describe("ApiClient control clients", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "http://backend.test/control/clients" && init?.method === "POST") {
          expect(init.body).toBe(JSON.stringify({ name: "Desktop client", scopes: ["jobs:read", "jobs:write"] }));
          return new Response(
            JSON.stringify({
              client: clientPage.items[0],
              token: "retinueos_live_abcdefgh1234_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
            }),
            { status: 201 },
          );
        }
        if (url === "http://backend.test/control/clients?cursor=next-page" && !init?.method) {
          return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        }
        if (url === "http://backend.test/control/clients" && !init?.method) {
          return new Response(JSON.stringify(clientPage), { status: 200 });
        }
        if (url === "http://backend.test/control/clients/client-1" && init?.method === "DELETE") {
          return new Response(JSON.stringify({ ...clientPage.items[0], revokedAt: "2026-08-26T13:00:00.000Z" }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("creates a named client with its explicitly selected scopes", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");

    const created = await client.createControlClient({ name: "Desktop client", scopes: ["jobs:read", "jobs:write"] });

    expect(created.client).toEqual(clientPage.items[0]);
    expect(created.token).toMatch(/^retinueos_live_/);
  });

  it("lists one paginated owner page and sends a cursor only when supplied", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");

    await expect(client.listControlClients()).resolves.toEqual(clientPage);
    await expect(client.listControlClients("next-page")).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("revokes a client with the owner delete endpoint", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");

    await expect(client.revokeControlClient("client-1")).resolves.toMatchObject({
      id: "client-1",
      revokedAt: "2026-08-26T13:00:00.000Z",
    });
  });
});

describe("control client access helpers", () => {
  it("accepts the paginated public response shape and rejects secret-bearing rows", () => {
    expect(isControlClientPage(clientPage)).toBe(true);
    expect(isControlClientPage({ items: [{ ...clientPage.items[0], tokenHash: "secret" }], nextCursor: null })).toBe(
      false,
    );
    expect(isControlClientPage({ ...clientPage, token: "retinueos_live_secret" })).toBe(false);
    expect(isControlClientPage(clientPage.items)).toBe(false);
  });

  it("groups scopes by the resource they authorize", () => {
    expect(groupControlScopes(["personas:read", "jobs:read", "jobs:write", "audit:read"])).toEqual([
      { label: "Personas", scopes: ["personas:read"] },
      { label: "Jobs", scopes: ["jobs:read", "jobs:write"] },
      { label: "Audit", scopes: ["audit:read"] },
    ]);
  });

  it("presents scope identifiers as readable capabilities", () => {
    expect(scopeLabel("approvals:write")).toBe("Resolve approvals");
  });

  it("adds the matching read scope for every selected write scope", () => {
    expect(pairReadScopesWithWrites(["jobs:write", "routines:write", "approvals:write"])).toEqual([
      "jobs:read",
      "jobs:write",
      "routines:read",
      "routines:write",
      "approvals:read",
      "approvals:write",
    ]);
  });

  it("builds the control MCP URL on the backend origin without a trailing slash", () => {
    expect(controlMcpUrl("https://api.example.com")).toBe("https://api.example.com/mcp/control");
    expect(controlMcpUrl("https://api.example.com/")).toBe("https://api.example.com/mcp/control");
    expect(controlMcpUrl("http://localhost:8080")).toBe("http://localhost:8080/mcp/control");
  });

  it("keeps a client created while the initial client list was loading", () => {
    const createdWhileLoading = {
      id: "client-2",
      name: "New desktop client",
      tokenPrefix: "prefix-two",
      scopes: ["routines:read" as const],
      createdAt: "2026-08-26T13:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };

    expect(mergeClientsAfterStaleLoad(clientPage.items, [createdWhileLoading])).toEqual([
      createdWhileLoading,
      ...clientPage.items,
    ]);
  });
});
