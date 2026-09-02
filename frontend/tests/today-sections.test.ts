import { describe, expect, it } from "vitest";
import {
  collapseAfterFive,
  doneTodayJobs,
  failedTodayCount,
  inFlightJobs,
  relativeTimeFrom,
  workingPersonaCount,
} from "../lib/today-sections.js";
import type { Job, JobStatus } from "../lib/api-client.js";

function job(overrides: Partial<Job> & { id: string; status: JobStatus }): Job {
  return {
    personaId: "wren",
    parentJobId: null,
    routineId: null,
    depth: 0,
    origin: "user",
    langgraphThreadId: `thread-${overrides.id}`,
    prompt: null,
    error: null,
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T08:00:00.000Z",
    retryEligible: false,
    ...overrides,
  };
}

describe("inFlightJobs", () => {
  it("keeps only queued/running/cancelling, newest first", () => {
    const jobs = [
      job({ id: "a", status: "done", updatedAt: "2026-08-28T09:00:00.000Z" }),
      job({ id: "b", status: "running", updatedAt: "2026-08-28T08:00:00.000Z" }),
      job({ id: "c", status: "queued", updatedAt: "2026-08-28T10:00:00.000Z" }),
      job({ id: "d", status: "waiting_approval", updatedAt: "2026-08-28T11:00:00.000Z" }),
    ];
    expect(inFlightJobs(jobs).map((j) => j.id)).toEqual(["c", "b"]);
  });
});

describe("workingPersonaCount", () => {
  it("counts distinct personas, not job rows", () => {
    const jobs = [
      job({ id: "a", status: "running", personaId: "wren" }),
      job({ id: "b", status: "running", personaId: "wren" }),
      job({ id: "c", status: "queued", personaId: "assistant" }),
    ];
    expect(workingPersonaCount(jobs)).toBe(2);
  });
});

describe("doneTodayJobs", () => {
  const now = new Date("2026-08-28T18:00:00.000Z");

  it("keeps only terminal jobs updated on the same local day, newest first", () => {
    const jobs = [
      job({ id: "today-early", status: "done", updatedAt: "2026-08-28T07:00:00.000Z" }),
      job({ id: "today-late", status: "failed", updatedAt: "2026-08-28T17:00:00.000Z" }),
      job({ id: "yesterday", status: "done", updatedAt: "2026-08-27T23:00:00.000Z" }),
      job({ id: "still-running", status: "running", updatedAt: "2026-08-28T12:00:00.000Z" }),
      job({ id: "waiting", status: "waiting_approval", updatedAt: "2026-08-28T12:00:00.000Z" }),
    ];
    expect(doneTodayJobs(jobs, now).map((j) => j.id)).toEqual(["today-late", "today-early"]);
  });
});

describe("failedTodayCount", () => {
  it("counts failure-shaped terminal statuses, not a cancellation the operator chose", () => {
    const doneToday = [
      job({ id: "a", status: "failed" }),
      job({ id: "b", status: "timed_out" }),
      job({ id: "c", status: "outcome_unknown" }),
      job({ id: "d", status: "cancelled" }),
      job({ id: "e", status: "done" }),
    ];
    expect(failedTodayCount(doneToday)).toBe(3);
  });
});

describe("relativeTimeFrom", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("renders sub-minute elapsed as just now", () => {
    expect(relativeTimeFrom("2026-08-28T11:59:40.000Z", now)).toBe("just now");
  });

  it("renders minutes, hours, and days at the right granularity", () => {
    expect(relativeTimeFrom("2026-08-28T11:41:00.000Z", now)).toBe("19m");
    expect(relativeTimeFrom("2026-08-28T08:00:00.000Z", now)).toBe("4h");
    expect(relativeTimeFrom("2026-08-25T12:00:00.000Z", now)).toBe("3d");
  });
});

describe("collapseAfterFive", () => {
  it("shows the first five and reports how many more there are", () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    expect(collapseAfterFive(items)).toEqual({ visible: [0, 1, 2, 3, 4], hiddenCount: 3 });
  });

  it("reports no hidden items when five or fewer", () => {
    expect(collapseAfterFive([1, 2, 3])).toEqual({ visible: [1, 2, 3], hiddenCount: 0 });
  });
});
