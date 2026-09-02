import { describe, expect, it } from "vitest";
import {
  dismissInstallPrompt,
  isInstallPromptDismissed,
  isIOSSafari,
  isStandalone,
  type InstallDismissalStore,
} from "../lib/install-prompt";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_MACISH =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MAC_SAFARI = IPAD_SAFARI_MACISH;
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

function memoryStore(initial: Record<string, string> = {}): InstallDismissalStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("isStandalone", () => {
  it("is standalone when the display-mode media query matches", () => {
    expect(isStandalone({ standaloneMedia: true, navigatorStandalone: undefined })).toBe(true);
  });

  it("is standalone when iOS Safari's navigator.standalone flag is set", () => {
    expect(isStandalone({ standaloneMedia: false, navigatorStandalone: true })).toBe(true);
  });

  it("is not standalone in an ordinary browser tab", () => {
    expect(isStandalone({ standaloneMedia: false, navigatorStandalone: false })).toBe(false);
    expect(isStandalone({ standaloneMedia: false, navigatorStandalone: undefined })).toBe(false);
  });
});

describe("isIOSSafari", () => {
  it("recognizes an iPhone running Safari", () => {
    expect(isIOSSafari({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 })).toBe(true);
  });

  it("recognizes an iPad reporting as Macintosh via its multi-touch screen", () => {
    expect(isIOSSafari({ userAgent: IPAD_SAFARI_MACISH, maxTouchPoints: 5 })).toBe(true);
  });

  it("excludes a real Mac (no touch points) with the same Safari user agent", () => {
    expect(isIOSSafari({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe(false);
  });

  it("excludes Chrome on iOS -- it cannot install a home-screen app", () => {
    expect(isIOSSafari({ userAgent: IPHONE_CHROME, maxTouchPoints: 5 })).toBe(false);
  });

  it("excludes Android Chrome, which gets the real beforeinstallprompt flow instead", () => {
    expect(isIOSSafari({ userAgent: ANDROID_CHROME, maxTouchPoints: 5 })).toBe(false);
  });
});

describe("install prompt dismissal", () => {
  it("is not dismissed with no store or an empty one", () => {
    expect(isInstallPromptDismissed(null)).toBe(false);
    expect(isInstallPromptDismissed(memoryStore())).toBe(false);
  });

  it("persists a dismissal so the prompt stays quiet on later checks", () => {
    const store = memoryStore();
    dismissInstallPrompt(store);
    expect(isInstallPromptDismissed(store)).toBe(true);
  });

  it("dismissing without a store (SSR/no window) is a harmless no-op", () => {
    expect(() => dismissInstallPrompt(null)).not.toThrow();
  });
});
