import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner } from "../components/offline-banner.js";

describe("OfflineBanner", () => {
  afterEach(() => vi.useRealTimers());

  it("renders nothing while online", () => {
    const markup = renderToStaticMarkup(<OfflineBanner online={true} lastSyncedAt={null} />);
    expect(markup).toBe("");
  });

  it("shows the amber strip with the last-synced time while offline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 8, 30));
    const lastSyncedAt = new Date(2026, 7, 29, 8, 12).getTime();
    const markup = renderToStaticMarkup(<OfflineBanner online={false} lastSyncedAt={lastSyncedAt} />);
    expect(markup).toContain("Offline · showing what we had at 08:12");
    expect(markup).toContain("bg-warning-soft");
  });
});
