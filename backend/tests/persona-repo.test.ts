import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "./setup/db.js";
import { personas, jobs, toolCalls } from "../src/db/schema.js";
import { wouldCreateReportingCycle } from "../src/personas/persona-repo.js";

const { db } = useTestDb();

describe("schema roundtrip", () => {
  it("inserts and reads back a persona", async () => {
    const [inserted] = await db()
      .insert(personas)
      .values({
        name: "Assistant",
        role: "Principal",
        systemPrompt: "You are the Principal.",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        assignedToolIds: [{ toolId: "delegate_to" }],
      })
      .returning();
    const [fetched] = await db().select().from(personas).where(eq(personas.id, inserted.id));
    expect(fetched.name).toBe("Assistant");
    expect(fetched.status).toBe("idle");
  });

  it("loads a legacy assigned-tool row that only has toolId and autonomy", async () => {
    const [inserted] = await db()
      .insert(personas)
      .values({
        name: "Legacy",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        assignedToolIds: [{ toolId: "write_state" }, { toolId: "get_weather", autonomy: "approval_required" }],
      })
      .returning();
    const [fetched] = await db().select().from(personas).where(eq(personas.id, inserted.id));
    expect(fetched.assignedToolIds).toEqual([
      { toolId: "write_state" },
      { toolId: "get_weather", autonomy: "approval_required" },
    ]);
  });

  it("supports job delegation fields (parentJobId, depth)", async () => {
    const [persona] = await db()
      .insert(personas)
      .values({
        name: "A",
        role: "R",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
      })
      .returning();
    const [root] = await db()
      .insert(jobs)
      .values({ personaId: persona.id, depth: 0, origin: "user", langgraphThreadId: "t1" })
      .returning();
    const [child] = await db()
      .insert(jobs)
      .values({
        personaId: persona.id,
        parentJobId: root.id,
        depth: 1,
        origin: "delegation",
        langgraphThreadId: "t2",
      })
      .returning();
    expect(child.parentJobId).toBe(root.id);
    expect(child.depth).toBe(1);
  });

  it("supports tool_calls risk_class", async () => {
    const [persona] = await db()
      .insert(personas)
      .values({ name: "A", role: "R", systemPrompt: "S", modelProvider: "anthropic", modelName: "m" })
      .returning();
    const [job] = await db()
      .insert(jobs)
      .values({ personaId: persona.id, depth: 0, origin: "user", langgraphThreadId: "t1", status: "running" })
      .returning();
    const [tc] = await db()
      .insert(toolCalls)
      .values({ jobId: job.id, toolId: "send_email", riskClass: "destructive", arguments: { to: "a@b.com" } })
      .returning();
    expect(tc.riskClass).toBe("destructive");
    expect(tc.status).toBe("pending_approval");
  });

  it("supports reportsTo (org chart) and defaults it to null", async () => {
    const [principal] = await db()
      .insert(personas)
      .values({ name: "Assistant", role: "Principal", systemPrompt: "S", modelProvider: "anthropic", modelName: "m" })
      .returning();
    expect(principal.reportsTo).toBeNull();

    const [report] = await db()
      .insert(personas)
      .values({
        name: "Budget Advisor",
        role: "Budgeting",
        systemPrompt: "S",
        modelProvider: "anthropic",
        modelName: "m",
        reportsTo: principal.id,
      })
      .returning();
    expect(report.reportsTo).toBe(principal.id);
  });
});

describe("wouldCreateReportingCycle", () => {
  async function hire(name: string, reportsTo?: string) {
    const [row] = await db()
      .insert(personas)
      .values({ name, role: "R", systemPrompt: "S", modelProvider: "anthropic", modelName: "m", reportsTo })
      .returning();
    return row;
  }

  it("is false for a manager with no chain back to the persona", async () => {
    const a = await hire("A");
    const b = await hire("B");
    expect(await wouldCreateReportingCycle(db(), a.id, b.id)).toBe(false);
  });

  it("is true for a persona reporting to itself", async () => {
    const a = await hire("A");
    expect(await wouldCreateReportingCycle(db(), a.id, a.id)).toBe(true);
  });

  it("is true for a transitive cycle (A -> B -> A)", async () => {
    const a = await hire("A");
    const b = await hire("B", a.id);
    expect(await wouldCreateReportingCycle(db(), a.id, b.id)).toBe(true);
  });
});
