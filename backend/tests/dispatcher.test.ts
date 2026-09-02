import { describe, it, expect, vi } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { runJob } from "../src/orchestration/dispatcher.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { personas } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { listModelCallsByJob } from "../src/models/model-call-repo.js";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});
const { generateText } = await import("ai");

const { db } = useTestDb();

describe("runJob", () => {
  it("completes without a tool call", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({ text: "hi there", toolCalls: [] } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "hello");
    expect(updated.status).toBe("done");
  });

  it("pauses on a destructive tool call", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "send_email" }],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          toolCallId: "call_1",
          toolName: "send_email",
          input: { to: "a@b.com", subject: "hi", body: "hi" },
        },
      ],
    } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "email a@b.com");
    expect(updated.status).toBe("waiting_approval");
  });

  it("writes the final assistant message to persona.lastSummary on successful completion", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    expect(persona.lastSummary).toBe("");
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "All caught up, nothing to report.",
      toolCalls: [],
    } as any);

    const updated = await runJob(db(), job, persona, defaultRegistry, undefined, "hello");
    expect(updated.status).toBe("done");

    const [row] = await db().select().from(personas).where(eq(personas.id, persona.id));
    expect(row.lastSummary).toBe("All caught up, nothing to report.");
  });

  it("does not touch lastSummary when the job pauses for approval", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [{ toolId: "send_email" }],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      toolCalls: [
        { toolCallId: "call_1", toolName: "send_email", input: { to: "a@b.com", subject: "hi", body: "hi" } },
      ],
    } as any);

    await runJob(db(), job, persona, defaultRegistry, undefined, "email a@b.com");

    const [row] = await db().select().from(personas).where(eq(personas.id, persona.id));
    expect(row.lastSummary).toBe("");
  });

  it("records a model_calls row with usage and finish reason for every generateText call", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-5",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "hi there",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    } as any);

    await runJob(db(), job, persona, defaultRegistry, undefined, "hello");

    const calls = await listModelCallsByJob(db(), job.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      jobId: job.id,
      personaId: persona.id,
      provider: "anthropic",
      model: "claude-sonnet-5",
      finishReason: "stop",
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      error: null,
    });
    expect(calls[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records a model_calls row with the error when generateText throws, and still fails the job", async () => {
    const persona = await createPersona(db(), {
      name: "A",
      role: "R",
      systemPrompt: "S",
      modelProvider: "anthropic",
      modelName: "m",
      assignedToolIds: [],
    });
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    vi.mocked(generateText).mockRejectedValueOnce(new Error("provider exploded"));

    await expect(runJob(db(), job, persona, defaultRegistry, undefined, "hello")).rejects.toThrow("provider exploded");

    const calls = await listModelCallsByJob(db(), job.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      finishReason: null,
      promptTokens: null,
      error: "provider exploded",
    });
  });
});
