"use client";

import { useEffect, useState } from "react";
import type { ApiClient } from "@/lib/api-client";
import { enablePushOnThisDevice, getPushBrowser } from "@/lib/push-enrollment";
import { pushNudgeState, type PushNudgeState } from "@/lib/push-nudge";

const DISMISS_KEY = "retinueos.push-nudge-dismissed";

export function PushNudgeStripView({
  state,
  onDismiss,
  onEnable,
}: {
  state: PushNudgeState;
  onDismiss: () => void;
  onEnable: () => void;
}) {
  if (state === "none") return null;

  const copy =
    state === "enable"
      ? { text: "Get these on your phone.", action: "Enable" as const }
      : state === "ios_not_installed"
        ? {
            text: "On iPhone or iPad, add RetinueOS to your Home Screen and open it from there to get push. Add to Home Screen from Safari's share sheet.",
            action: null,
          }
        : {
            text: "Permission was denied. Allow notifications for this site in your browser's settings to turn this back on.",
            action: null,
          };

  return (
    <div
      className="mx-2 mb-2 flex items-center gap-2 rounded-button p-3 font-sans text-[13px]"
      style={{ background: "var(--warning-soft)", color: "var(--warning-soft-fg)" }}
    >
      <span className="flex-1">{copy.text}</span>
      {copy.action && (
        <button type="button" onClick={onEnable} className="min-h-11 flex-none font-medium underline">
          {copy.action}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="min-h-11 flex-none border-0 bg-transparent"
      >
        ×
      </button>
    </div>
  );
}

export function PushNudgeStrip({ client }: { client: ApiClient }) {
  const [state, setState] = useState<PushNudgeState>("none");
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "true");
    } catch {
      setDismissed(false);
    }
    (async () => {
      const browser = getPushBrowser();
      const registration = await browser?.getServiceWorkerRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!cancelled) setState(pushNudgeState({ browser, enrolledHere: Boolean(subscription) }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // Best-effort -- a private window or blocked storage just means this
      // strip can reappear next session, not a functional failure.
    }
  }

  if (dismissed) return null;
  return <PushNudgeStripView state={state} onDismiss={dismiss} onEnable={() => enablePushOnThisDevice(client)} />;
}
