import { describe, expect, it } from "vitest";
import { pushNudgeState } from "../lib/push-nudge";
import type { PushBrowserPort } from "../lib/push-enrollment";

function browser(permission: NotificationPermission): PushBrowserPort {
  return {
    permission,
    requestPermission: async () => permission,
    registerServiceWorker: async () => ({
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => {
          throw new Error("unused");
        },
      },
    }),
    getServiceWorkerRegistration: async () => undefined,
  };
}

describe("pushNudgeState", () => {
  it("is none once this device is already enrolled", () => {
    expect(pushNudgeState({ browser: browser("granted"), enrolledHere: true })).toBe("none");
  });

  it("is ios_not_installed when the browser context has no Push API at all", () => {
    expect(pushNudgeState({ browser: null, enrolledHere: false })).toBe("ios_not_installed");
  });

  it("is denied when permission was explicitly refused", () => {
    expect(pushNudgeState({ browser: browser("denied"), enrolledHere: false })).toBe("denied");
  });

  it("is enable when the API is available, unrefused, and not yet turned on here", () => {
    expect(pushNudgeState({ browser: browser("default"), enrolledHere: false })).toBe("enable");
  });
});
