import { describe, expect, it } from "vitest";
import { offlineBannerText } from "../lib/last-synced.js";

describe("offlineBannerText", () => {
  it("shows the last-synced clock time, zero-padded", () => {
    const lastSyncedAt = new Date(2026, 7, 29, 8, 12).getTime();
    expect(offlineBannerText(lastSyncedAt, lastSyncedAt + 60_000)).toBe("Offline · showing what we had at 08:12");
  });

  it("falls back to no time when nothing has ever synced", () => {
    expect(offlineBannerText(null, Date.now())).toBe("Offline · showing what we had.");
  });

  it("calls out real staleness instead of a clock time from yesterday", () => {
    const lastSyncedAt = new Date(2026, 7, 27, 8, 12).getTime();
    const now = new Date(2026, 7, 29, 9, 0).getTime();
    expect(offlineBannerText(lastSyncedAt, now)).toBe("Offline · showing what we had — it's been a while.");
  });
});
