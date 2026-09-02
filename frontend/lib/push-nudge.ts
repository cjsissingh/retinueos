import type { PushBrowserPort } from "./push-enrollment";

export type PushNudgeState = "none" | "enable" | "ios_not_installed" | "denied";

/**
 * Which of the three non-empty push nudge strips applies, or "none"
 * to render nothing. `browser === null` covers both a genuinely
 * unsupported desktop browser and -- the common real case -- iOS Safari
 * before the app is added to the Home Screen (see push-enrollment.ts's
 * getPushBrowser, which returns null whenever serviceWorker/PushManager/
 * Notification aren't present).
 */
export function pushNudgeState(input: { browser: PushBrowserPort | null; enrolledHere: boolean }): PushNudgeState {
  if (input.enrolledHere) return "none";
  if (!input.browser) return "ios_not_installed";
  if (input.browser.permission === "denied") return "denied";
  return "enable";
}
