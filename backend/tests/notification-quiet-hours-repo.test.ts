import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import {
  getQuietHours,
  isWithinQuietHours,
  updateQuietHours,
} from "../src/notifications/notification-quiet-hours-repo.js";

const { db } = useTestDb();

describe("getQuietHours", () => {
  it("seeds the default 22:00-07:00 window on first read", async () => {
    const hours = await getQuietHours(db());
    expect(hours).toMatchObject({ enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 });
  });
});

describe("updateQuietHours", () => {
  it("persists a new window", async () => {
    await getQuietHours(db());
    const updated = await updateQuietHours(db(), { startMinute: 23 * 60, endMinute: 6 * 60 });
    expect(updated).toMatchObject({ startMinute: 1380, endMinute: 360 });
  });
});

describe("isWithinQuietHours", () => {
  const window = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };

  it("is true late at night, wrapping past midnight", () => {
    expect(isWithinQuietHours(window, new Date("2026-08-29T23:30:00"))).toBe(true);
    expect(isWithinQuietHours(window, new Date("2026-08-29T05:00:00"))).toBe(true);
  });

  it("is false during the day", () => {
    expect(isWithinQuietHours(window, new Date("2026-08-29T12:00:00"))).toBe(false);
  });

  it("treats the start as inclusive and the end as exclusive", () => {
    expect(isWithinQuietHours(window, new Date("2026-08-29T22:00:00"))).toBe(true);
    expect(isWithinQuietHours(window, new Date("2026-08-29T07:00:00"))).toBe(false);
  });

  it("is always false when disabled", () => {
    expect(isWithinQuietHours({ ...window, enabled: false }, new Date("2026-08-29T23:30:00"))).toBe(false);
  });
});
