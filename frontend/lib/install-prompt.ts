/**
 * platform detection + dismissal persistence for the in-app PWA
 * install prompt (components/install-prompt.tsx). Split out from the
 * component so the browser-specific bits are unit-testable without a DOM
 * -- same "port" idiom as lib/push-enrollment.ts's PushBrowserPort.
 */

// Chromium's `beforeinstallprompt` isn't part of lib.dom -- there is no
// standard type for it.
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export interface InstallEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  standaloneMedia: boolean;
  navigatorStandalone: boolean | undefined;
}

export interface InstallDismissalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DISMISSED_KEY = "retinueos-install-dismissed";

/**
 * True once the app is already installed: Chromium/desktop report it via
 * the `display-mode: standalone` media query, iOS Safari via the
 * non-standard `navigator.standalone` flag it sets once launched from the
 * home screen. Either means never show the prompt.
 */
export function isStandalone(env: Pick<InstallEnvironment, "standaloneMedia" | "navigatorStandalone">): boolean {
  return env.standaloneMedia || env.navigatorStandalone === true;
}

/**
 * iOS/iPadOS has no `beforeinstallprompt` API, so it only ever gets the
 * Share -> Add to Home Screen coaching copy -- and only in Safari itself,
 * since other iOS browsers can't install a home-screen app at all. iPadOS
 * 13+ reports as "Macintosh" in the user agent; multi-touch is what tells
 * it apart from an actual Mac.
 */
export function isIOSSafari(env: Pick<InstallEnvironment, "userAgent" | "maxTouchPoints">): boolean {
  const ua = env.userAgent.toLowerCase();
  const isIOSDevice = /iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && env.maxTouchPoints > 1);
  const isSafariBrowser = /safari/.test(ua) && !/crios|fxios|edgios|opios|android/.test(ua);
  return isIOSDevice && isSafariBrowser;
}

export function getInstallEnvironment(): InstallEnvironment | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standaloneMedia: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    // SAFETY: `standalone` is Safari's non-standard iOS install flag,
    // absent from lib.dom's Navigator type -- there is no unchecked field
    // access here, just a widened type for one Apple-only property.
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
  };
}

export function getInstallDismissalStore(): InstallDismissalStore | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function isInstallPromptDismissed(store: InstallDismissalStore | null): boolean {
  return store?.getItem(DISMISSED_KEY) === "1";
}

export function dismissInstallPrompt(store: InstallDismissalStore | null): void {
  store?.setItem(DISMISSED_KEY, "1");
}
