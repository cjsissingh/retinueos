import { describe, expect, it } from "vitest";
import { useTestDb } from "./setup/db.js";
import {
  ensureNotificationPreferencesSeeded,
  ForcedChannelError,
  getNotificationPreference,
  listNotificationPreferences,
  NOTIFICATION_PREFERENCE_DEFAULTS,
  updateNotificationPreference,
} from "../src/notifications/notification-preference-repo.js";

const { db } = useTestDb();

describe("notification preference defaults", () => {
  it("matches the delivery matrix in docs/DESIGN.md §04", () => {
    expect(NOTIFICATION_PREFERENCE_DEFAULTS.approval_needed).toEqual({
      inAppEnabled: true,
      pushEnabled: true,
      digestEnabled: false,
    });
    expect(NOTIFICATION_PREFERENCE_DEFAULTS.job_finished).toEqual({
      inAppEnabled: true,
      pushEnabled: false,
      digestEnabled: true,
    });
    expect(NOTIFICATION_PREFERENCE_DEFAULTS.routine_ran).toEqual({
      inAppEnabled: false,
      pushEnabled: false,
      digestEnabled: true,
    });
  });
});

describe("ensureNotificationPreferencesSeeded / listNotificationPreferences", () => {
  it("seeds exactly one row per kind with the default matrix, idempotently", async () => {
    await ensureNotificationPreferencesSeeded(db());
    await ensureNotificationPreferencesSeeded(db());
    const rows = await listNotificationPreferences(db());
    expect(rows).toHaveLength(6);
    const jobFinished = rows.find((row) => row.kind === "job_finished");
    expect(jobFinished).toMatchObject({ inAppEnabled: true, pushEnabled: false, digestEnabled: true });
  });
});

describe("updateNotificationPreference", () => {
  it("updates a togglable channel", async () => {
    await ensureNotificationPreferencesSeeded(db());
    const updated = await updateNotificationPreference(db(), "job_finished", { pushEnabled: true });
    expect(updated.pushEnabled).toBe(true);
  });

  it("rejects turning off in-app for a forced kind", async () => {
    await ensureNotificationPreferencesSeeded(db());
    await expect(updateNotificationPreference(db(), "approval_needed", { inAppEnabled: false })).rejects.toThrow(
      ForcedChannelError,
    );
    const row = await getNotificationPreference(db(), "approval_needed");
    expect(row.inAppEnabled).toBe(true);
  });

  it("still allows turning push off for a forced kind", async () => {
    await ensureNotificationPreferencesSeeded(db());
    const updated = await updateNotificationPreference(db(), "approval_needed", { pushEnabled: false });
    expect(updated.pushEnabled).toBe(false);
  });
});
