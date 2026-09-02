"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClient, ApiError, type NotificationPreference, type PushConfig, type QuietHours } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  getPushBrowser,
  type PushBrowserPort,
} from "@/lib/push-enrollment";
import { PageHeader } from "@/components/page-header";
import { PAGE_PAD, PRIMARY_BUTTON } from "@/lib/touch-layout";
import { NotificationMatrixTable } from "@/components/notification-matrix-table";
import { Toggle } from "@/components/ui/toggle";

type LoadState = "loading" | "ready" | "error";

export function NotificationSettings() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [browser] = useState<PushBrowserPort | null>(() => getPushBrowser());
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [enabledHere, setEnabledHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [quietHours, setQuietHours] = useState<QuietHours | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [nextConfig, nextPreferences, nextQuietHours] = await Promise.all([
        client.getPushConfig(),
        client.getNotificationPreferences(),
        client.getQuietHours(),
      ]);
      setConfig(nextConfig);
      setPreferences(nextPreferences);
      setQuietHours(nextQuietHours);
      const registration = await browser?.getServiceWorkerRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      setEnabledHere(Boolean(subscription));
      setLoadState("ready");
    } catch (error) {
      if (handleUnauthorized(error, router)) return;
      setLoadState("error");
    }
  }, [browser, client, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  async function enable() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await enablePushOnThisDevice(client, browser);
      if (result.status === "enabled") {
        setEnabledHere(true);
        setConfig((previous) => (previous ? { ...previous, deviceCount: result.deviceCount } : previous));
        setNotice("Notifications are enabled on this device.");
      } else if (result.status === "denied") {
        setNotice("Permission was denied. Allow notifications in this browser's site settings, then try again.");
      } else if (result.status === "unsupported") {
        setNotice("This browser context does not support Web Push.");
      } else if (result.status === "unavailable") {
        setNotice("Web Push is not configured on the RetinueOS server.");
      }
    } catch (error) {
      if (handleUnauthorized(error, router)) return;
      setNotice(
        error instanceof ApiError
          ? (error.detail ?? "Couldn't enable notifications.")
          : "Couldn't enable notifications.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await disablePushOnThisDevice(client, browser);
      if (result.status === "disabled") {
        setEnabledHere(false);
        setConfig((previous) => (previous ? { ...previous, deviceCount: result.deviceCount } : previous));
        setNotice("Notifications are disabled on this device.");
      }
    } catch (error) {
      if (handleUnauthorized(error, router)) return;
      setNotice(
        error instanceof ApiError
          ? (error.detail ?? "Couldn't disable notifications.")
          : "Couldn't disable notifications.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow="Settings"
        title="Notifications"
        description="Choose where updates reach you without silencing anything that needs a decision."
      />
      <section className="max-w-[760px] border-b pb-8" style={{ borderColor: "var(--border)" }}>
        <h2 className="m-0 font-serif text-xl text-fg">This device</h2>
        <p className="mb-5 mt-2 max-w-[58ch] font-sans text-sm leading-6 text-fg-muted">
          Enable this browser to receive only the job and routine outcomes you explicitly select. Repeat this once on
          every device where you want notifications.
        </p>

        {loadState === "loading" && <p className="font-sans text-sm text-fg-muted">Checking this device…</p>}
        {loadState === "error" && (
          <button type="button" onClick={load} className="font-sans text-sm underline text-fg-muted">
            Couldn't load notification settings. Try again.
          </button>
        )}
        {loadState === "ready" && (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <span
                className="rounded-full px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider"
                style={{
                  background: enabledHere ? "var(--success-soft)" : "var(--neutral-soft)",
                  color: enabledHere ? "var(--success-soft-fg)" : "var(--neutral-soft-fg)",
                }}
              >
                {enabledHere ? "Enabled here" : "Disabled here"}
              </span>
              <span className="font-sans text-sm text-fg-muted">
                {config?.deviceCount ?? 0} enabled {(config?.deviceCount ?? 0) === 1 ? "device" : "devices"} total
              </span>
            </div>

            {!browser && (
              <p className="mb-5 rounded-button bg-warning-soft p-3 font-sans text-sm text-warning-soft-fg">
                Web Push is unavailable here. On iPhone or iPad, add RetinueOS to your Home Screen and open the
                installed app before enabling notifications.
              </p>
            )}
            {browser && !config?.available && (
              <p className="mb-5 rounded-button bg-warning-soft p-3 font-sans text-sm text-warning-soft-fg">
                Web Push is not configured on the RetinueOS server yet.
              </p>
            )}

            <button
              type="button"
              disabled={busy || (!enabledHere && (!browser || !config?.available))}
              onClick={enabledHere ? disable : enable}
              className={`${PRIMARY_BUTTON} px-4 text-sm disabled:opacity-50`}
              style={{
                background: enabledHere ? "var(--neutral-soft)" : "var(--accent)",
                color: enabledHere ? "var(--neutral-soft-fg)" : "var(--accent-fg)",
              }}
            >
              {busy
                ? "Working…"
                : enabledHere
                  ? "Disable notifications on this device"
                  : "Enable notifications on this device"}
            </button>
          </>
        )}
        {notice && <p className="mb-0 mt-4 font-sans text-sm text-fg-muted">{notice}</p>}
      </section>
      {loadState === "ready" && (
        <section className="mt-8 max-w-[760px]">
          <h2 className="m-0 font-serif text-xl text-fg">Delivery matrix</h2>
          <p className="mb-5 mt-2 max-w-[58ch] font-sans text-sm leading-6 text-fg-muted">
            In-app is required for anything that needs you — you are the fallback when work is blocked.
          </p>
          <NotificationMatrixTable
            preferences={preferences}
            onChange={async (kind, patch) => {
              const updated = await client.updateNotificationPreference(kind, patch);
              setPreferences((prev) => prev.map((p) => (p.kind === kind ? updated : p)));
            }}
          />

          <div className="mt-10 border-t pt-8" style={{ borderColor: "var(--border)" }}>
            <h2 className="m-0 font-serif text-xl text-fg">Quiet hours</h2>
            <p className="mb-4 mt-2 max-w-[58ch] font-sans text-sm leading-6 text-fg-muted">
              Push is held during this window; in-app rows still land so the morning list is complete. A held approval
              push is sent once the window ends if it&apos;s still unacted.
            </p>
            {quietHours && (
              <div className="flex flex-col gap-4 font-sans text-sm text-fg sm:flex-row sm:flex-wrap sm:items-end">
                <label className="flex min-h-11 items-center gap-3">
                  <Toggle
                    checked={quietHours.enabled}
                    onChange={async (checked) => {
                      const updated = await client.updateQuietHours({ enabled: checked });
                      setQuietHours(updated);
                    }}
                    label="Quiet hours enabled"
                  />
                  Enabled
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-fg-muted">From</span>
                  <input
                    type="time"
                    value={`${String(Math.floor(quietHours.startMinute / 60)).padStart(2, "0")}:${String(
                      quietHours.startMinute % 60,
                    ).padStart(2, "0")}`}
                    onChange={async (e) => {
                      const parts = e.target.value.split(":").map(Number);
                      const hours = parts[0];
                      const minutes = parts[1];
                      if (
                        hours === undefined ||
                        minutes === undefined ||
                        Number.isNaN(hours) ||
                        Number.isNaN(minutes)
                      ) {
                        return;
                      }
                      const updated = await client.updateQuietHours({ startMinute: hours * 60 + minutes });
                      setQuietHours(updated);
                    }}
                    className="min-h-11 rounded-button border bg-surface px-3"
                    style={{ borderColor: "var(--border-strong)" }}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-fg-muted">To</span>
                  <input
                    type="time"
                    value={`${String(Math.floor(quietHours.endMinute / 60)).padStart(2, "0")}:${String(
                      quietHours.endMinute % 60,
                    ).padStart(2, "0")}`}
                    onChange={async (e) => {
                      const parts = e.target.value.split(":").map(Number);
                      const hours = parts[0];
                      const minutes = parts[1];
                      if (
                        hours === undefined ||
                        minutes === undefined ||
                        Number.isNaN(hours) ||
                        Number.isNaN(minutes)
                      ) {
                        return;
                      }
                      const updated = await client.updateQuietHours({ endMinute: hours * 60 + minutes });
                      setQuietHours(updated);
                    }}
                    className="min-h-11 rounded-button border bg-surface px-3"
                    style={{ borderColor: "var(--border-strong)" }}
                  />
                </label>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
