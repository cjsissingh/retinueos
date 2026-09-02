"use client";

import { useEffect, useState } from "react";

/**
 * `navigator.onLine` plus the `online`/`offline` window events,
 * wrapped as a hook so the composer, ApprovalItem, and the offline banner
 * all agree on the same signal. Defaults to `true` (matches SSR, where
 * `navigator` doesn't exist) rather than `false` -- an online app briefly
 * reading as offline on first paint would wrongly disable Approve/Decline
 * and the composer for a frame; a genuinely offline launch corrects itself
 * as soon as this effect runs, same tradeoff as the config-gate comment
 * above in app-shell.tsx.
 */
export function useOnlineStatus(): boolean {
  // `typeof navigator` guards SSR/prerendering (no global `navigator` at
  // all there) -- unlike `navigator?.onLine`, `typeof` never throws on an
  // unbound identifier, so it's the only safe check before `navigator`
  // is known to exist. Where a minimal global `navigator` *is* present
  // (some Node versions, this repo's test runner) but lacks `onLine`,
  // that reads `undefined` (falsy) rather than throwing, so it still
  // needs its own explicit type check rather than defaulting to "offline".
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : typeof navigator.onLine === "boolean" ? navigator.onLine : true,
  );

  useEffect(() => {
    function goOnline() {
      setOnline(true);
    }
    function goOffline() {
      setOnline(false);
    }
    setOnline(navigator.onLine);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
