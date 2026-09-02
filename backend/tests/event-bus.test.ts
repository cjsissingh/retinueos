import { describe, expect, it, vi } from "vitest";
import { JobEventBus } from "../src/orchestration/event-bus.js";
import { listJobEventsAfter } from "../src/orchestration/job-event-repo.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { useTestDb } from "./setup/db.js";

describe("JobEventBus", () => {
  it("isolates a throwing subscriber and continues delivering to the others", () => {
    const bus = new JobEventBus();
    const received: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    bus.subscribe("job-1", () => {
      throw new Error("subscriber exploded");
    });
    bus.subscribe("job-1", (event) => received.push(event.type));

    try {
      expect(() => bus.publish("job-1", { type: "status", status: "running" })).not.toThrow();
      expect(received).toEqual(["status"]);
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("JobEventBus persistence", () => {
  const { db } = useTestDb();

  async function makeJob() {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    return createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
  }

  it("durably logs every published event once setPersistence is called, in publish order", async () => {
    const bus = new JobEventBus();
    bus.setPersistence(db());
    const job = await makeJob();

    bus.publish(job.id, { type: "status", status: "running" });
    bus.publish(job.id, { type: "model_end", content: "hi" });
    bus.publish(job.id, { type: "status", status: "done" });

    // publish() is fire-and-forget relative to its own persistence write --
    // await the bus's persistQueue instead of a fixed sleep.
    await bus.flushPersistence();

    const rows = await listJobEventsAfter(db(), job.id, 0);
    expect(rows.map((r) => r.event)).toEqual([
      { type: "status", status: "running" },
      { type: "model_end", content: "hi" },
      { type: "status", status: "done" },
    ]);
    // Ascending, assigned by Postgres on insert -- a real cursor a client
    // can resume from.
    expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
    expect(rows[1]!.id).toBeLessThan(rows[2]!.id);
  });

  it("scopes listJobEventsAfter to one job and to ids strictly after the cursor", async () => {
    const bus = new JobEventBus();
    bus.setPersistence(db());
    const jobA = await makeJob();
    const jobB = await makeJob();

    bus.publish(jobA.id, { type: "status", status: "running" });
    bus.publish(jobB.id, { type: "status", status: "running" });
    bus.publish(jobA.id, { type: "status", status: "done" });
    await bus.flushPersistence();

    const allForA = await listJobEventsAfter(db(), jobA.id, 0);
    expect(allForA).toHaveLength(2);
    expect(allForA.every((r) => r.event.type === "status")).toBe(true);

    const afterFirst = await listJobEventsAfter(db(), jobA.id, allForA[0]!.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.event).toEqual({ type: "status", status: "done" });
  });

  it("still delivers live even when persistence fails, and logs the error instead of throwing", async () => {
    const bus = new JobEventBus();
    // A db pointed at a job that doesn't exist yet -> the FK constraint on
    // job_events.job_id makes every insert fail, simulating a persistence
    // outage without needing to break the db connection itself.
    bus.setPersistence(db());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const received: string[] = [];
    const unsubscribe = bus.subscribe("no-such-job", (event) => received.push(event.type));

    try {
      expect(() => bus.publish("no-such-job", { type: "status", status: "running" })).not.toThrow();
      expect(received).toEqual(["status"]);
      await bus.flushPersistence();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      unsubscribe();
      consoleError.mockRestore();
    }
  });
});
