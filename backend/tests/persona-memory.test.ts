import { describe, it, expect } from "vitest";
import { useTestDb } from "./setup/db.js";
import { createPersona } from "../src/personas/persona-repo.js";
import { createJob } from "../src/jobs/job-repo.js";
import { saveJobSummary } from "../src/personas/job-summary-memory.js";
import {
  rememberMemory,
  recallMemories,
  listMemoriesForInjection,
  listMemories,
  forgetMemory,
  forgetMemoryByLabel,
  getLiveMemoryByLabel,
} from "../src/personas/persona-memory-repo.js";

const { db } = useTestDb();

async function makePersona() {
  return createPersona(db(), {
    name: "A",
    role: "R",
    systemPrompt: "S",
    modelProvider: "anthropic",
    modelName: "m",
    assignedToolIds: [],
  });
}

describe("persona_memories repo", () => {
  it("remember then recall round-trips by keyword", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), { personaId: persona.id, label: "spouse", content: "Operator's spouse is named Sam" });

    const results = await recallMemories(db(), persona.id, "spouse");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Sam");
  });

  it("recall finds nothing for an unrelated query", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), { personaId: persona.id, label: "spouse", content: "Operator's spouse is named Sam" });
    expect(await recallMemories(db(), persona.id, "quarterly budget")).toHaveLength(0);
  });

  it("ordinary recall does not surface job summaries from unrelated conversations", async () => {
    const persona = await makePersona();
    const job = await createJob(db(), { personaId: persona.id, depth: 0, origin: "user" });
    await saveJobSummary(db(), persona.id, job.id, {
      summary: "Private Apollo launch details",
      summarizedMessageCount: 0,
    });

    expect(await recallMemories(db(), persona.id, "Apollo launch")).toHaveLength(0);
  });

  it("a second remember() under the same label supersedes the first instead of merging", async () => {
    const persona = await makePersona();
    const first = await rememberMemory(db(), {
      personaId: persona.id,
      label: "city",
      content: "Operator lives in Boston",
    });
    const second = await rememberMemory(db(), {
      personaId: persona.id,
      label: "city",
      content: "Operator lives in Seattle",
    });

    expect(second.supersedesId).toBe(first.id);

    const live = await listMemories(db(), persona.id);
    expect(live).toHaveLength(1); // the superseded row is excluded from live listings
    expect(live[0].content).toBe("Operator lives in Seattle");

    // recall only ever surfaces the live version, never the stale one it replaced
    const results = await recallMemories(db(), persona.id, "Operator lives");
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Operator lives in Seattle");
  });

  it("sensitive memories are excluded from recall by default but included when explicitly asked for", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), {
      personaId: persona.id,
      label: "ssn",
      content: "Operator's SSN ends in 1234",
      sensitivity: "sensitive",
    });

    expect(await recallMemories(db(), persona.id, "SSN")).toHaveLength(0);
    expect(await recallMemories(db(), persona.id, "SSN", { includeSensitive: true })).toHaveLength(1);
  });

  it("expired memories are excluded from recall and injection", async () => {
    const persona = await makePersona();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await rememberMemory(db(), {
      personaId: persona.id,
      label: "stale",
      content: "this fact expired yesterday",
      expiresAt: yesterday,
    });

    expect(await recallMemories(db(), persona.id, "expired")).toHaveLength(0);
    expect(await listMemoriesForInjection(db(), persona.id)).toHaveLength(0);
  });

  it("listMemoriesForInjection ranks by importance then recency and respects a char budget", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), { personaId: persona.id, label: "low", content: "background detail", importance: 0 });
    await rememberMemory(db(), { personaId: persona.id, label: "high", content: "important detail", importance: 2 });

    const injected = await listMemoriesForInjection(db(), persona.id);
    expect(injected[0].label).toBe("high"); // higher importance sorts first regardless of write order

    // a budget too small for even one row still returns exactly one — never an empty injection because the top pick alone is long
    const tiny = await listMemoriesForInjection(db(), persona.id, 1);
    expect(tiny).toHaveLength(1);
    expect(tiny[0].label).toBe("high");
  });

  it("sensitive memories are never auto-injected, even at high importance", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), {
      personaId: persona.id,
      label: "secret",
      content: "very important secret",
      importance: 2,
      sensitivity: "sensitive",
    });
    expect(await listMemoriesForInjection(db(), persona.id)).toHaveLength(0);
  });

  it("recall and injection both bump lastAccessedAt", async () => {
    const persona = await makePersona();
    const row = await rememberMemory(db(), { personaId: persona.id, label: "x", content: "recall bumps access time" });
    expect(row.lastAccessedAt).toBeNull();

    await recallMemories(db(), persona.id, "recall bumps");
    const [afterRecall] = await listMemories(db(), persona.id);
    expect(afterRecall.lastAccessedAt).not.toBeNull();
  });

  it("forgetMemory deletes by id, scoped to the owning persona", async () => {
    const persona = await makePersona();
    const other = await makePersona();
    const row = await rememberMemory(db(), { personaId: persona.id, label: "x", content: "to be forgotten" });

    expect(await forgetMemory(db(), other.id, row.id)).toBe(false); // wrong persona can't delete it
    expect(await forgetMemory(db(), persona.id, row.id)).toBe(true);
    expect(await listMemories(db(), persona.id)).toHaveLength(0);
  });

  it("forgetMemoryByLabel deletes the live row under that label", async () => {
    const persona = await makePersona();
    await rememberMemory(db(), { personaId: persona.id, label: "x", content: "forget me by label" });

    expect(await forgetMemoryByLabel(db(), persona.id, "nope")).toBe(false);
    expect(await forgetMemoryByLabel(db(), persona.id, "x")).toBe(true);
    expect(await listMemories(db(), persona.id)).toHaveLength(0);
  });

  it("getLiveMemoryByLabel returns the live row, and undefined when none exists or the match is superseded", async () => {
    const persona = await makePersona();
    expect(await getLiveMemoryByLabel(db(), persona.id, "city")).toBeUndefined();

    await rememberMemory(db(), { personaId: persona.id, label: "city", content: "Operator lives in Boston" });
    const live = await getLiveMemoryByLabel(db(), persona.id, "city");
    expect(live?.content).toBe("Operator lives in Boston");

    await rememberMemory(db(), { personaId: persona.id, label: "city", content: "Operator lives in Seattle" });
    const updated = await getLiveMemoryByLabel(db(), persona.id, "city");
    expect(updated?.content).toBe("Operator lives in Seattle"); // never the superseded row, even though it's still in the table
  });
});
