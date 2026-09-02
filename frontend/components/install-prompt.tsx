"use client";

import { useCallback, useEffect, useState } from "react";
import {
  dismissInstallPrompt,
  getInstallDismissalStore,
  getInstallEnvironment,
  isInstallPromptDismissed,
  isIOSSafari,
  isStandalone,
  type BeforeInstallPromptEvent,
} from "@/lib/install-prompt";
import { PRIMARY_BUTTON } from "@/lib/touch-layout";

type Offer = "android" | "ios" | null;

/**
 * coax people into installing the PWA instead of leaving them to
 * discover "Add to Home Screen" on their own. Chromium/Android gets the
 * real `beforeinstallprompt` flow; iOS Safari has no such API, so it gets
 * a short Share-sheet explainer instead. Either surface goes quiet for
 * good once dismissed (retinueos-install-dismissed in localStorage -- same
 * idiom as lib/auth.ts's stored password) rather than nagging on every
 * load. Never shown once already installed (standalone display).
 */
export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [offer, setOffer] = useState<Offer>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const env = getInstallEnvironment();
    if (!env || isStandalone(env) || isInstallPromptDismissed(getInstallDismissalStore())) return;

    if (isIOSSafari(env)) {
      setOffer("ios");
      return;
    }

    function onBeforeInstallPrompt(event: Event) {
      // Stops Chromium's own mini-infobar so this in-app control is the
      // only install affordance.
      event.preventDefault();
      // SAFETY: this handler is only ever attached to the `beforeinstallprompt`
      // event name, whose payload is this shape -- lib.dom just has no type for it.
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setOffer("android");
    }
    function onInstalled() {
      setOffer(null);
      setDeferredPrompt(null);
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    dismissInstallPrompt(getInstallDismissalStore());
    setOffer(null);
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // A user-declined native prompt reads the same as an explicit
      // dismissal: stay quiet on later loads instead of asking again.
      if (choice.outcome !== "accepted") dismissInstallPrompt(getInstallDismissalStore());
      setOffer(null);
    } finally {
      setDeferredPrompt(null);
      setInstalling(false);
    }
  }, [deferredPrompt]);

  if (!offer) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-[calc(2.75rem+env(safe-area-inset-bottom,0px)+12px)] z-30 mx-auto flex max-w-[420px] items-center gap-3 rounded-card border px-4 py-3 shadow-overlay md:inset-x-auto md:bottom-5 md:left-5"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 font-sans text-[13px] font-medium text-fg">Install RetinueOS</p>
        <p className="m-0 mt-0.5 font-sans text-xs leading-relaxed text-fg-muted">
          {offer === "ios"
            ? "Tap Share, then Add to Home Screen, for a full-screen app with offline access."
            : "Add it to your home screen for a faster, full-screen experience."}
        </p>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {offer === "android" && (
          <button
            type="button"
            onClick={install}
            disabled={installing}
            className={`${PRIMARY_BUTTON} disabled:opacity-60`}
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="min-h-11 rounded-button border-0 bg-transparent px-2 font-sans text-[13px] text-fg-faint"
        >
          {offer === "ios" ? "Got it" : "Not now"}
        </button>
      </div>
    </div>
  );
}
