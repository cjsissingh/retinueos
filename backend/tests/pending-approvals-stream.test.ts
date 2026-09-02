import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { createToolCall } from "../src/tool-calls/tool-call-repo.js";
import { streamRoutes } from "../src/stream/stream-routes.js";
import { JobEventBus } from "../src/orchestration/event-bus.js";
import { PendingApprovalBus } from "../src/orchestration/pending-approval-bus.js";

const { db } = useTestDb();

function parseSseEvents(text: string): Array<{ type: string; items?: Array<{ id: string }> }> {
  const events: Array<{ type: string; items?: Array<{ id: string }> }> = [];
  for (const chunk of text.split("\n\n")) {
    if (!chunk.trim()) continue;
    let data: unknown;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data: ")) data = JSON.parse(line.slice("data: ".length));
    }
    if (data && typeof data === "object" && "type" in data) {
      events.push(data as { type: string; items?: Array<{ id: string }> });
    }
  }
  return events;
}

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 2_000,
): Promise<Array<{ type: string; items?: Array<{ id: string }> }>> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (parseSseEvents(text).length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) => setTimeout(() => resolve({ done: true }), remaining)),
    ]);
    if (result.done) break;
    if (result.value) text += decoder.decode(result.value, { stream: true });
  }
  return parseSseEvents(text);
}

describe("GET /pending_approvals/stream", () => {
  it("sends the current pending snapshot on connect, then live updates", async () => {
    const pendingBus = new PendingApprovalBus();
    const app = new Hono();
    app.route("/", streamRoutes(db(), new JobEventBus(), pendingBus));

    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    const pending = await createToolCall(db(), {
      jobId: job.id,
      toolId: "send_email",
      riskClass: "destructive",
      arguments: { to: "a@b.com" },
    });

    const res = await app.request("/pending_approvals/stream");
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    try {
      const first = await readSseEvents(reader, 1);
      expect(first).toHaveLength(1);
      expect(first[0]!.type).toBe("pending");
      expect(first[0]!.items?.map((item) => item.id)).toEqual([pending.id]);

      pendingBus.publish([]);
      const next = await readSseEvents(reader, 1);
      expect(next).toHaveLength(1);
      expect(next[0]!.type).toBe("pending");
      expect(next[0]!.items).toEqual([]);
    } finally {
      await reader.cancel();
    }
  });
});
