import { describe, expect, it } from "vitest";
import { notificationToastHref, reconcileSeen, shouldAutoDismiss, visibleToasts } from "../lib/toast-rules";

interface T {
  id: number;
  message: string;
  persist: boolean;
}

function toast(id: number, persist: boolean): T {
  return { id, message: `toast ${id}`, persist };
}

function row(id: string) {
  return { id };
}

describe("shouldAutoDismiss", () => {
  it("is true for an outcome toast and false for a needs-you (persist) toast", () => {
    expect(shouldAutoDismiss({ persist: false })).toBe(true);
    expect(shouldAutoDismiss({ persist: true })).toBe(false);
  });
});

describe("visibleToasts", () => {
  it("shows every toast with no overflow at or under the cap", () => {
    const toasts = [toast(1, false), toast(2, false), toast(3, false)];
    expect(visibleToasts(toasts)).toEqual({ visible: toasts, overflow: 0 });
  });

  it("caps at 3 visible and reports the rest as overflow", () => {
    const toasts = [toast(1, false), toast(2, false), toast(3, false), toast(4, false)];
    const result = visibleToasts(toasts);
    expect(result.visible.map((t) => t.id)).toEqual([2, 3, 4]);
    expect(result.overflow).toBe(1);
  });
});

describe("reconcileSeen", () => {
  it("does nothing while not ready, even with a pre-fetch empty snapshot", () => {
    expect(reconcileSeen(null, false, [])).toEqual({ seen: null, arrived: [] });
  });

  it("primes silently off the first ready snapshot, however many rows it has", () => {
    const result = reconcileSeen(null, true, [row("a"), row("b")]);
    expect(result.arrived).toEqual([]);
    expect(result.seen).toEqual(new Set(["a", "b"]));
  });

  it("does not replay the primed snapshot as arrivals on the next ready tick", () => {
    const primed = reconcileSeen(null, true, [row("a"), row("b")]);
    const result = reconcileSeen(primed.seen, true, [row("a"), row("b")]);
    expect(result.arrived).toEqual([]);
  });

  it("reports only genuinely new rows once primed", () => {
    const primed = reconcileSeen(null, true, [row("a")]);
    const result = reconcileSeen(primed.seen, true, [row("a"), row("b")]);
    expect(result.arrived).toEqual([row("b")]);
    expect(result.seen).toEqual(new Set(["a", "b"]));
  });

  it("ignores a not-ready tick that arrives between two ready ones (still-loading refetch)", () => {
    const primed = reconcileSeen(null, true, [row("a")]);
    const stale = reconcileSeen(primed.seen, false, []);
    expect(stale).toEqual({ seen: primed.seen, arrived: [] });
  });
});

describe("notificationToastHref", () => {
  it("opens the job's chat, not the activity log, when both ids are known", () => {
    expect(notificationToastHref({ jobId: "job-1", personaId: "persona-1" })).toBe("/roster/persona-1?chat=job-1");
  });

  it("falls back to the centre when there is no job+persona pair", () => {
    expect(notificationToastHref({ jobId: null, personaId: null })).toBe("/notifications");
    expect(notificationToastHref({ jobId: "job-1", personaId: null })).toBe("/notifications");
  });
});
