import { describe, it, expect } from "vitest";
import { useTestDb } from "./setup/db.js";
import {
  createCustomTool,
  createCustomToolVersion,
  getCustomToolVersion,
  listCustomTools,
  listCustomToolVersions,
  reviewCustomToolVersion,
  type CustomToolProposalInput,
} from "../src/tools/custom-tool-repo.js";

const { db } = useTestDb();

function makeInput(overrides: Partial<CustomToolProposalInput> = {}): CustomToolProposalInput {
  return {
    description: "Reads today's weather from a scraped page.",
    source: "export function run() { return { ok: true }; }",
    parametersSchema: { type: "object", properties: {} },
    hostAllowList: ["example.com"],
    secretRefs: [],
    limits: { timeoutMs: 5_000, memoryMb: 128, maxOutputBytes: 65_536 },
    suggestedRiskClass: "read_only",
    ...overrides,
  };
}

describe("createCustomTool", () => {
  it("creates version 1 at status pending", async () => {
    const row = await createCustomTool(db(), "weather-scraper", makeInput());
    expect(row.toolKey).toBe("weather-scraper");
    expect(row.version).toBe(1);
    expect(row.status).toBe("pending");
  });

  it("rejects a toolKey that already exists", async () => {
    await createCustomTool(db(), "dup-key", makeInput());
    await expect(createCustomTool(db(), "dup-key", makeInput())).rejects.toThrow(/already exists/);
  });
});

describe("createCustomToolVersion", () => {
  it("inserts version 2 without touching version 1", async () => {
    await createCustomTool(db(), "versioned", makeInput({ description: "v1" }));
    const v2 = await createCustomToolVersion(db(), "versioned", makeInput({ description: "v2" }));
    expect(v2.version).toBe(2);
    expect(v2.status).toBe("pending");
    const v1 = await getCustomToolVersion(db(), "versioned", 1);
    expect(v1?.description).toBe("v1");
  });

  it("rejects an unknown toolKey", async () => {
    await expect(createCustomToolVersion(db(), "no-such-key", makeInput())).rejects.toThrow(/not found/);
  });
});

describe("listCustomTools / listCustomToolVersions", () => {
  it("lists one row per toolKey, the latest version", async () => {
    await createCustomTool(db(), "list-me", makeInput({ description: "v1" }));
    await createCustomToolVersion(db(), "list-me", makeInput({ description: "v2" }));
    const list = await listCustomTools(db());
    const entry = list.find((row) => row.toolKey === "list-me");
    expect(entry?.version).toBe(2);
    expect(entry?.description).toBe("v2");
  });

  it("lists every version for one toolKey, ascending", async () => {
    await createCustomTool(db(), "history", makeInput());
    await createCustomToolVersion(db(), "history", makeInput());
    const versions = await listCustomToolVersions(db(), "history");
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("reviewCustomToolVersion", () => {
  it("approves a pending version", async () => {
    await createCustomTool(db(), "approve-me", makeInput());
    const outcome = await reviewCustomToolVersion(db(), "approve-me", 1, { status: "approved" });
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome === "ok") {
      expect(outcome.row.status).toBe("approved");
      expect(outcome.row.reviewedAt).toBeInstanceOf(Date);
    }
  });

  it("returns not_found for an unknown version", async () => {
    const outcome = await reviewCustomToolVersion(db(), "does-not-exist", 1, { status: "approved" });
    expect(outcome.outcome).toBe("not_found");
  });

  it("returns not_pending and does not overwrite an already-decided version", async () => {
    await createCustomTool(db(), "already-decided", makeInput());
    await reviewCustomToolVersion(db(), "already-decided", 1, { status: "rejected", reviewNote: "no" });
    const second = await reviewCustomToolVersion(db(), "already-decided", 1, { status: "approved" });
    expect(second.outcome).toBe("not_pending");
    if (second.outcome === "not_pending") expect(second.row.status).toBe("rejected");
  });
});
