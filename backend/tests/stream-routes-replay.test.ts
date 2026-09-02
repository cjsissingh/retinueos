// backend/tests/stream-routes-replay.test.ts
//
// Reconnect replay (job_events + the Last-Event-ID / ?after= cursor) is
// deliberately tested against a locally-constructed JobEventBus, not the
// shared defaultJobEventBus stream-routes.test.ts uses -- setPersistence is
// a one-way, instance-level opt-in, and mutating the module singleton here
// would leak into that file's tests (and vice versa, depending on run order).
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob, transitionJobStatus } from "../src/jobs/job-repo.js";
import { streamRoutes } from "../src/stream/stream-routes.js";
import { JobEventBus } from "../src/orchestration/event-bus.js";

const { db } = useTestDb();

function parseSseLines(text: string): Array<{ id?: string; data: { type: string; [k: string]: unknown } }> {
  const events: Array<{ id?: string; data: { type: string; [k: string]: unknown } }> = [];
  for (const chunk of text.split("\n\n")) {
    if (!chunk.trim()) continue;
    let id: string | undefined;
    let data: unknown;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice("id: ".length);
      if (line.startsWith("data: ")) data = JSON.parse(line.slice("data: ".length));
    }
    if (data) events.push({ id, data: data as { type: string } });
  }
  return events;
}

async function readAllUntilClosed(res: Response, maxChunks = 50): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function makeTerminalJob(bus: JobEventBus) {
  const persona = await createPersona(db(), {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
  const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
  bus.publish(job.id, { type: "status", status: "running" });
  bus.publish(job.id, { type: "model_end", content: "partial" });
  bus.publish(job.id, { type: "tool_call", toolId: "send_email", arguments: {} });
  bus.publish(job.id, { type: "tool_result", toolId: "send_email", result: { ok: true } });
  await transitionJobStatus(db(), job.id, "queued", "running");
  await transitionJobStatus(db(), job.id, "running", "done");
  bus.publish(job.id, { type: "status", status: "done" });
  return job;
}

describe("GET /jobs/:id/stream reconnect replay", () => {
  it("replays no backlog on an ordinary first connect (no cursor given)", async () => {
    const bus = new JobEventBus();
    bus.setPersistence(db());
    const app = new Hono();
    app.route("/", streamRoutes(db(), bus));
    const job = await makeTerminalJob(bus);
    await bus.flushPersistence();

    const res = await app.request(`/jobs/${job.id}/stream`);
    const events = parseSseLines(await readAllUntilClosed(res));

    // Only the fresh status snapshot this connection reads on its own --
    // none of the four events published before it connected, and none of
    // them carry an `id:` (the synthetic snapshot isn't a job_events row).
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ type: "status", status: "done" });
    expect(events[0]!.id).toBeUndefined();
  });

  it("replays the durable backlog after the given cursor via ?after=, oldest first, each carrying its row id", async () => {
    const bus = new JobEventBus();
    bus.setPersistence(db());
    const app = new Hono();
    app.route("/", streamRoutes(db(), bus));
    const job = await makeTerminalJob(bus);
    await bus.flushPersistence();

    const res = await app.request(`/jobs/${job.id}/stream?after=0`);
    const events = parseSseLines(await readAllUntilClosed(res));

    // All 5 published events are durably backlogged (running/model_end/
    // tool_call/tool_result/done), each with a real ascending id, then the
    // fresh status snapshot on top -- itself carrying no id (it's
    // synthesized at connect time, not a job_events row), even though its
    // content happens to repeat the backlog's own last entry.
    expect(events).toHaveLength(6);
    expect(events.slice(0, 5).map((e) => e.data)).toEqual([
      { type: "status", status: "running" },
      { type: "model_end", content: "partial" },
      { type: "tool_call", toolId: "send_email", arguments: {} },
      { type: "tool_result", toolId: "send_email", result: { ok: true } },
      { type: "status", status: "done" },
    ]);
    const ids = events.slice(0, 5).map((e) => Number(e.id));
    expect(ids.every((n) => Number.isFinite(n))).toBe(true);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(events[5]!.data).toEqual({ type: "status", status: "done" });
    expect(events[5]!.id).toBeUndefined();
  });

  it("resumes from a mid-stream cursor instead of replaying from the start", async () => {
    const bus = new JobEventBus();
    bus.setPersistence(db());
    const app = new Hono();
    app.route("/", streamRoutes(db(), bus));
    const job = await makeTerminalJob(bus);
    await bus.flushPersistence();

    const full = await app.request(`/jobs/${job.id}/stream?after=0`);
    const fullEvents = parseSseLines(await readAllUntilClosed(full));
    const secondEventId = fullEvents[1]!.id; // "model_end"

    const resumed = await app.request(`/jobs/${job.id}/stream?after=${secondEventId}`);
    const resumedEvents = parseSseLines(await readAllUntilClosed(resumed));

    // Everything after "model_end" (tool_call, tool_result), then the fresh
    // status snapshot -- not "running"/"model_end" again.
    expect(resumedEvents.slice(0, 2).map((e) => e.data)).toEqual([
      { type: "tool_call", toolId: "send_email", arguments: {} },
      { type: "tool_result", toolId: "send_email", result: { ok: true } },
    ]);
    expect(resumedEvents.at(-1)!.data).toEqual({ type: "status", status: "done" });
  });

  it("honors the Last-Event-ID header the same way as ?after=, since that's what a real EventSource reconnect sends", async () => {
    const bus = new JobEventBus();
    bus.setPersistence(db());
    const app = new Hono();
    app.route("/", streamRoutes(db(), bus));
    const job = await makeTerminalJob(bus);
    await bus.flushPersistence();

    const res = await app.request(`/jobs/${job.id}/stream`, { headers: { "Last-Event-ID": "0" } });
    const events = parseSseLines(await readAllUntilClosed(res));
    expect(events).toHaveLength(6);
    expect(events[0]!.data).toEqual({ type: "status", status: "running" });
  });
});
