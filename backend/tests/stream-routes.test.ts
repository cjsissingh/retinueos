// backend/tests/stream-routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { jobRoutes } from "../src/jobs/job-routes.js";
import { streamRoutes } from "../src/stream/stream-routes.js";
import { defaultJobEventBus } from "../src/orchestration/event-bus.js";
import { JobWorker } from "../src/orchestration/job-worker.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { insertNotification } from "../src/notifications/notification-repo.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

function parseSseLine(line: string): { type: string; [k: string]: unknown } | null {
  if (!line.startsWith("data: ")) return null;
  return JSON.parse(line.slice("data: ".length));
}

describe("GET /notifications/stream", () => {
  it("streams the current notification snapshot on connect", async () => {
    await insertNotification(db(), { kind: "job_finished", title: "Finished", message: "done" });
    const app = new Hono();
    app.route("/", streamRoutes(db(), defaultJobEventBus));
    const controller = new AbortController();

    const response = await app.request("/notifications/stream", { signal: controller.signal });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("expected notifications stream body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const event = decoder
      .decode(value)
      .split("\n")
      .map(parseSseLine)
      .find((candidate) => candidate !== null);

    expect(event).toMatchObject({ type: "notifications" });
    const items = event?.items as Array<{ body?: string; message?: string }>;
    expect(items[0]).toMatchObject({ body: "done", kind: "job_finished" });
    expect(items[0]).not.toHaveProperty("message");
    controller.abort();
    await reader.cancel();
  });
});

describe("GET /jobs/:id/stream", () => {
  it("streams status events until the job reaches a terminal state", async () => {
    // jobRoutes runs runJob without an explicit bus argument, so it publishes
    // to the module-singleton defaultJobEventBus (see dispatcher.ts's
    // `bus: JobEventBus = defaultJobEventBus` default). streamRoutes must
    // subscribe to that same singleton instance -- a locally-constructed
    // `new JobEventBus()` here would never see runJob's events and the
    // stream would hang until the job's terminal status is not observed.
    const app = new Hono();
    app.route("/jobs", jobRoutes(db(), undefined));
    app.route("/", streamRoutes(db(), defaultJobEventBus));

    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });

    vi.mocked(generateText).mockResolvedValueOnce({ text: "done", toolCalls: [] } as any);
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hi" }),
    });
    expect(createRes.status).toBe(202);
    const job = await createRes.json();

    const streamRes = await app.request(`/jobs/${job.id}/stream`);
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const execution = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 }).runOnce();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    for (let i = 0; i < 50 && !sawDone; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";
      for (const chunk of lines) {
        for (const line of chunk.split("\n")) {
          const event = parseSseLine(line);
          if (event?.type === "status" && event.status === "done") sawDone = true;
        }
      }
    }
    await execution;
    expect(sawDone).toBe(true);
  });

  it("streams a failed status when runJob rejects, instead of hanging forever", async () => {
    // Regression test for the reported bug: the runJob failure path used to
    // update the database and nothing else. That writes the DB
    // row, but this route never re-polls it -- it only relays JobEventBus
    // events -- so anyone already connected to /stream when the job died
    // saw nothing further, ever. The fix publishes a matching "status:
    // failed" event alongside the DB write; this asserts the stream
    // actually receives it instead of the connection just hanging.
    const app = new Hono();
    app.route("/jobs", jobRoutes(db(), undefined));
    app.route("/", streamRoutes(db(), defaultJobEventBus));

    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });

    // Controlled rejection: the real bug only shows up for a client that's
    // already watching /stream when the job dies later. Letting generateText
    // reject immediately (as job-routes.test.ts does) races the subscribe --
    // this keeps runJob pending until the stream is confirmed connected and
    // has read its initial "running" status, then fails it on cue.
    let rejectGenerate!: (err: Error) => void;
    let markGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      markGenerateStarted = resolve;
    });
    vi.mocked(generateText).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectGenerate = reject;
          markGenerateStarted();
        }),
    );
    const createRes = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: persona.id, prompt: "hi" }),
    });
    expect(createRes.status).toBe(202);
    const job = await createRes.json();

    const streamRes = await app.request(`/jobs/${job.id}/stream`);
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const execution = new JobWorker({ db: db(), registry: defaultRegistry, concurrency: 1 }).runOnce();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawRunning = false;
    let sawFailed = false;
    for (let i = 0; i < 50 && !sawFailed; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";
      for (const chunk of lines) {
        for (const line of chunk.split("\n")) {
          const event = parseSseLine(line);
          if (event?.type === "status" && event.status === "running" && !sawRunning) {
            sawRunning = true;
            // The stream has confirmed the initial "running" status (so it's
            // subscribed to the bus, not just reading a stale DB snapshot) --
            // wait until the provider call itself has started, then fail the
            // job the way a real provider outage would. The worker publishes
            // "running" immediately before dispatch, so assuming the mock has
            // already been entered here is a scheduling race.
            await generateStarted;
            rejectGenerate(new Error("provider exploded"));
          }
          if (event?.type === "status" && event.status === "failed") sawFailed = true;
        }
      }
    }
    await execution;
    expect(sawRunning).toBe(true);
    expect(sawFailed).toBe(true);
  });
});
