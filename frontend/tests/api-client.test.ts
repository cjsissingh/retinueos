import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiClient, ApiError } from "../lib/api-client.js";

describe("ApiClient", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/personas") && (!init || init.method === undefined)) {
          return new Response(JSON.stringify([{ id: "p1", name: "A" }]), { status: 200 });
        }
        if (url.endsWith("/personas/templates")) {
          return new Response(
            JSON.stringify([{ slug: "personal-assistant", name: "Alex", role: "Personal Assistant" }]),
            { status: 200 },
          );
        }
        if (url.endsWith("/personas/generate") && init?.method === "POST") {
          // SAFETY: this fake fetch's own branches only ever set `init.body`
          // to a JSON.stringify'd string (ApiClient.request always does),
          // never a Blob/FormData/etc -- the cast just names what every
          // caller here already passes.
          const body = JSON.parse(init.body as string);
          if (body.description === "fail me") {
            return new Response(JSON.stringify({ error: "Couldn't generate a persona draft." }), { status: 502 });
          }
          return new Response(
            JSON.stringify({
              name: "Nova",
              role: "Reading Coach",
              systemPrompt: "Help track and discuss books.",
              voiceNotes: "",
              boundaries: "",
              scopeDescription: "Reading list tracking.",
              defaultTools: [{ toolId: "remember", permission: "allow" }],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/personas") && init?.method === "POST") {
          const headers = new Headers(init.headers);
          expect(headers.get("X-Auth-Password")).toBe("secret");
          return new Response(JSON.stringify({ id: "p2", name: "B" }), { status: 201 });
        }
        if (url.endsWith("/config")) {
          return new Response(
            JSON.stringify({ availableProviders: ["anthropic"], ready: true, webSearchAvailable: true }),
            { status: 200 },
          );
        }
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ models: { anthropic: ["claude-sonnet-5"] } }), { status: 200 });
        }
        if (url.endsWith("/personas/p1/model_calls")) {
          return new Response(
            JSON.stringify([
              {
                id: "mc1",
                jobId: "j1",
                personaId: "p1",
                provider: "anthropic",
                model: "claude-sonnet-5",
                finishReason: "stop",
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
                latencyMs: 842,
                error: null,
                createdAt: "2026-08-23T00:00:00.000Z",
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/personas/p1/state") && (!init || init.method === undefined)) {
          return new Response(
            JSON.stringify([
              {
                id: "s1",
                personaId: "p1",
                key: "inbox-suggestions",
                content: "3 flagged",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/personas/p1/state/inbox-suggestions") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/personas/p1/state/waiting%20on%20you") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/personas/p1/memories") && (!init || init.method === undefined)) {
          return new Response(
            JSON.stringify([
              {
                id: "m1",
                personaId: "p1",
                label: "operator-location",
                content: "Operator moved to Seattle.",
                sourceJobId: null,
                supersedesId: null,
                supersededAt: null,
                sensitivity: "normal",
                importance: 1,
                expiresAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                lastAccessedAt: null,
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/personas/p1/memories/m1") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/personas/p2") && init?.method === "PATCH") {
          // SAFETY: this fake fetch's own branches only ever set `init.body`
          // to a JSON.stringify'd string (ApiClient.request always does),
          // never a Blob/FormData/etc -- the cast just names what every
          // caller here already passes.
          const body = JSON.parse(init.body as string);
          if ("reportsTo" in body) {
            expect(init.body).toBe(JSON.stringify({ reportsTo: "p1" }));
            return new Response(JSON.stringify({ id: "p2", name: "B", reportsTo: "p1" }), { status: 200 });
          }
          if ("name" in body) {
            return new Response(JSON.stringify({ id: "p2", ...body }), { status: 200 });
          }
          expect(init.body).toBe(JSON.stringify({ modelProvider: "openai", modelName: "gpt-5" }));
          return new Response(JSON.stringify({ id: "p2", name: "B", modelProvider: "openai", modelName: "gpt-5" }), {
            status: 200,
          });
        }
        if (url.endsWith("/digests") && (!init || init.method === undefined)) {
          return new Response(
            JSON.stringify([
              {
                id: "d1",
                personaId: "p1",
                routineId: null,
                generatedAt: "2026-01-01T00:00:00.000Z",
                content: "Sitting untouched: inbox-suggestions.",
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/digests/d1") && (!init || init.method === undefined)) {
          return new Response(
            JSON.stringify({
              id: "d1",
              personaId: "p1",
              routineId: null,
              generatedAt: "2026-01-01T00:00:00.000Z",
              content: "Sitting untouched: inbox-suggestions.",
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("attaches the auth password header and parses JSON responses", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const personas = await client.listPersonas();
    expect(personas).toEqual([{ id: "p1", name: "A" }]);

    const created = await client.createPersona({
      name: "B",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    expect(created).toEqual({ id: "p2", name: "B" });
  });

  it("fetches the starter persona templates", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const templates = await client.listPersonaTemplates();
    expect(templates).toEqual([{ slug: "personal-assistant", name: "Alex", role: "Personal Assistant" }]);
  });

  it("generates a persona draft from a description", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const draft = await client.generatePersonaDraft({ description: "Someone to track my reading list" });
    expect(draft.name).toBe("Nova");
    expect(draft.defaultTools).toEqual([{ toolId: "remember", permission: "allow" }]);
  });

  it("surfaces a generation failure as an ApiError", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    await expect(client.generatePersonaDraft({ description: "fail me" })).rejects.toThrow(ApiError);
  });

  it("fetches which model providers have an API key configured, and whether the app is ready", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const config = await client.getConfig();
    expect(config).toEqual({ availableProviders: ["anthropic"], ready: true, webSearchAvailable: true });
  });

  it("fetches each configured provider's live model list", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const catalog = await client.getModels();
    expect(catalog).toEqual({ models: { anthropic: ["claude-sonnet-5"] } });
  });

  it("reassigns a persona's manager via PATCH", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const updated = await client.setPersonaManager("p2", "p1");
    expect(updated).toEqual({ id: "p2", name: "B", reportsTo: "p1" });
  });

  it("fixes a persona's model via PATCH", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const updated = await client.setPersonaModel("p2", "openai", "gpt-5");
    expect(updated).toEqual({ id: "p2", name: "B", modelProvider: "openai", modelName: "gpt-5" });
  });

  it("fetches a persona's recorded model calls", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const calls = await client.listModelCalls("p1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "mc1", provider: "anthropic", model: "claude-sonnet-5", totalTokens: 150 });
  });

  it("lists a persona's live memories", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const memories = await client.listMemories("p1");
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ id: "m1", label: "operator-location", content: "Operator moved to Seattle." });
  });

  it("deletes a memory and treats the empty 204 body as success, not a parse error", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    await expect(client.deleteMemory("p1", "m1")).resolves.toBeUndefined();
  });

  it("lists a persona's loop-state keys", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const state = await client.listPersonaState("p1");
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ key: "inbox-suggestions", content: "3 flagged" });
  });

  it("deletes a loop-state key, encoding the path segment", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    await expect(client.deletePersonaState("p1", "inbox-suggestions")).resolves.toBeUndefined();
    await expect(client.deletePersonaState("p1", "waiting on you")).resolves.toBeUndefined();
  });

  it("lists digests and fetches one by id", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const list = await client.listDigests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "d1", content: "Sitting untouched: inbox-suggestions." });
    const one = await client.getDigest("d1");
    expect(one.id).toBe("d1");
  });

  it("updates identity and charter fields via the general updatePersona PATCH", async () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const updated = await client.updatePersona("p2", {
      name: "B2",
      role: "New role",
      systemPrompt: "New purpose",
      voiceNotes: "Dry",
      boundaries: "Never trades",
      scopeDescription: "Inbox only",
      assignedToolIds: [{ toolId: "send_email" }],
    });
    expect(updated).toEqual({
      id: "p2",
      name: "B2",
      role: "New role",
      systemPrompt: "New purpose",
      voiceNotes: "Dry",
      boundaries: "Never trades",
      scopeDescription: "Inbox only",
      assignedToolIds: [{ toolId: "send_email" }],
    });
  });
});

describe("ApiClient push and notification intent", () => {
  it("sends explicit notification intent on job creation and continuation", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: "j1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");

    await client.createJob({ personaId: "p1", prompt: "hi", notifyOnOutcome: true });
    await client.continueJob("j1", "more", false);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ personaId: "p1", prompt: "hi", notifyOnOutcome: true }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ prompt: "more", notifyOnOutcome: false }),
    });
  });

  it("sends Idempotency-Key on create and continue so a lost response can be retried safely", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: "j1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");

    await client.createJob({ personaId: "p1", prompt: "hi" }, "send-1");
    await client.continueJob("j1", "more", true, "send-1");

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe("send-1");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe("send-1");
  });

  it("retryJob posts to /jobs/:id/retry with an idempotency key", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: "job-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");

    await client.retryJob("job-1", "key-1");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/jobs/job-1/retry");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("key-1");
  });

  it("gets push configuration and registers and removes one endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/push/config")) {
        return new Response(JSON.stringify({ available: true, publicKey: "public", deviceCount: 2 }), { status: 200 });
      }
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ registered: true }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");
    const subscription = { endpoint: "https://push.test/a", keys: { p256dh: "p", auth: "a" } };

    await expect(client.getPushConfig()).resolves.toEqual({ available: true, publicKey: "public", deviceCount: 2 });
    await client.registerPushSubscription(subscription);
    await client.deletePushSubscription(subscription.endpoint);

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify(subscription) });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  });

  it("sends notifyRoutineRan on routine create and update", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "r1", notifyRoutineRan: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");

    await client.createRoutine("p1", {
      name: "Fitness Check",
      cronSchedule: "30 20 * * *",
      promptTemplate: "Check the log.",
      notifyRoutineRan: true,
    });
    await client.setRoutineNotifyRoutineRan("r1", false);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        name: "Fitness Check",
        cronSchedule: "30 20 * * *",
        promptTemplate: "Check the log.",
        notifyRoutineRan: true,
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ notifyRoutineRan: false }),
    });
  });

  it("always-allows a tool call via POST /tool_calls/:id/always-allow", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "tc1", status: "approved" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");
    await expect(client.alwaysAllowToolCall("tc1")).resolves.toEqual({ id: "tc1", status: "approved" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://backend.test/tool_calls/tc1/always-allow");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });
});

describe("ApiClient error handling", () => {
  it("carries the server's { error } message on ApiError.detail instead of discarding the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'No API key configured for provider "anthropic" — set ANTHROPIC_API_KEY.' }),
            { status: 409 },
          ),
      ),
    );
    const client = new ApiClient("http://backend.test", () => "secret");
    await expect(client.createJob({ personaId: "p1", prompt: "hi" })).rejects.toMatchObject({
      status: 409,
      detail: 'No API key configured for provider "anthropic" — set ANTHROPIC_API_KEY.',
    });
  });

  it("falls back to a status-only message when the error body doesn't parse as { error }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 500 })),
    );
    const client = new ApiClient("http://backend.test", () => "secret");
    try {
      await client.createJob({ personaId: "p1", prompt: "hi" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      // SAFETY: the `toBeInstanceOf` assertion just above is this test's
      // real check that `err` is an ApiError -- narrowing into a local once
      // reads its fields afterward without repeating the cast per line.
      const apiErr = err as ApiError;
      expect(apiErr.detail).toBeNull();
      expect(apiErr.message).toContain("500");
    }
  });
});

/** Minimal stand-in for the browser's EventSource -- good enough to drive
 *  ApiClient.streamJob's onmessage handler and observe whether it called
 *  .close(), without pulling in a real SSE client or a DOM environment. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  // Test fixture standing in for an SSE payload, deliberately varied per
  // test case -- there's no one shape to name here.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
  }
}

describe("ApiClient.streamJob", () => {
  beforeEach(() => {
    FakeEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("closes the EventSource once the job reaches a terminal status", () => {
    // Regression test: EventSource auto-reconnects on any connection close
    // it didn't itself trigger, including the backend gracefully ending the
    // SSE response once a job goes terminal -- without an explicit close()
    // here, the browser would keep reopening this stream forever.
    const client = new ApiClient("http://backend.test", () => "secret");
    client.streamJob("job-1", () => {});
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "status", status: "running" });
    expect(source.closed).toBe(false);

    source.emit({ type: "status", status: "done" });
    expect(source.closed).toBe(true);
  });

  it("does not close on a non-terminal status", () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    client.streamJob("job-1", () => {});
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "model_end", content: "hi" });
    source.emit({ type: "status", status: "running" });
    expect(source.closed).toBe(false);
  });
});

describe("ApiClient.streamPendingApprovals", () => {
  beforeEach(() => {
    FakeEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("does not close the EventSource on pending snapshots — this stream is long-lived", () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const items: unknown[] = [];
    client.streamPendingApprovals((next) => items.push(next));
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "pending", items: [{ id: "tc1" }] });
    source.emit({ type: "pending", items: [] });
    expect(source.closed).toBe(false);
    expect(items).toEqual([[{ id: "tc1" }], []]);
    expect(source.url).toBe("http://backend.test/pending_approvals/stream?password=secret");
  });

  it("ignores non-pending events on the workspace approvals stream", () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const items: unknown[] = [];
    client.streamPendingApprovals((next) => items.push(next));
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "status", status: "running" });
    expect(items).toEqual([]);
  });
});

describe("ApiClient notifications", () => {
  it("lists notifications with the paged public shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "n1",
              kind: "job_failed",
              personaId: "p1",
              jobId: "j1",
              toolCallId: null,
              title: "Failed",
              body: "Wren failed.",
              createdAt: "2026-08-29T12:00:00.000Z",
              readAt: null,
              actedAt: null,
            },
          ],
          nextCursor: null,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");

    const page = await client.listNotifications({ needsYou: true, limit: 10 });

    expect(page.items[0]).toMatchObject({ kind: "job_failed", body: "Wren failed." });
    expect(fetchMock.mock.calls[0][0]).toBe("http://backend.test/notifications?needs_you=true&limit=10");
    vi.unstubAllGlobals();
  });

  it("marks one notification read and marks all read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "n1", readAt: "2026-08-29T12:00:00.000Z" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ updated: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient("http://backend.test", () => "secret");

    expect((await client.markNotificationRead("n1")).readAt).toBe("2026-08-29T12:00:00.000Z");
    expect(await client.markAllNotificationsRead()).toEqual({ updated: 3 });
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
    vi.unstubAllGlobals();
  });
});

describe("ApiClient.streamNotifications", () => {
  beforeEach(() => {
    FakeEventSource.instances.length = 0;
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("delivers notification snapshots and ignores other event types", () => {
    const client = new ApiClient("http://backend.test", () => "secret");
    const items: unknown[] = [];
    client.streamNotifications((next) => items.push(next));
    const source = FakeEventSource.instances[0]!;

    source.emit({ type: "notifications", items: [{ id: "n1" }] });
    source.emit({ type: "pending", items: [{ id: "tc1" }] });

    expect(items).toEqual([[{ id: "n1" }]]);
    expect(source.url).toBe("http://backend.test/notifications/stream?password=secret");
  });
});
