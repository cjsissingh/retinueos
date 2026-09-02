"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ApiClient, type ConfigStatus, type Persona } from "@/lib/api-client";
import { clearStoredPassword, getStoredPassword } from "@/lib/auth";
import { getLastSyncedAt, recordSync } from "@/lib/last-synced";
import { registerServiceWorker } from "@/lib/register-service-worker";
import { shouldRenderChrome } from "@/lib/shell-auth-gate";
import { SHELL_LAYOUT } from "@/lib/touch-layout";
import { MORE_NAV, PRIMARY_NAV, SETTINGS_NAV, type NavItem } from "@/lib/nav";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { useOnlineStatus } from "@/lib/use-online-status";
import { DispatchDialog } from "./dispatch-dialog";
import { BrandMark } from "./brand-mark";
import { InstallPrompt } from "./install-prompt";
import { MobileNav } from "./mobile-nav";
import { NotificationBell } from "./notification-bell";
import { NotificationToasts } from "./notification-toasts";
import { OfflineBanner } from "./offline-banner";
import { SetupRequired } from "./setup-required";
import { ToastProvider } from "./toast";
import { Sheet } from "./ui/sheet";
import { PendingApprovalsProvider, usePendingApprovalsLive } from "@/lib/use-pending-approvals";
import { NotificationsProvider, useNotificationsLive, type NotificationsValue } from "@/lib/use-notifications";

// Personas + config only — pending approvals live on the workspace SSE
// (use-pending-approvals.tsx), with this same cadence as a fallback there.
const POLL_MS = 15_000;

function navSvg(children: React.ReactNode) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

// One glyph per NAV item, keyed by href -- the icon-only 64px sidebar tier
// (md-shell-lg, design doc §05) has no room for labels, so every
// destination needs a mark distinct enough to read at a glance. A Map (not
// a plain object) so looking one up by an arbitrary `item.href` string
// stays a real, non-widened `React.ReactNode | undefined` lookup instead
// of an unsafe index-signature cast.
const NAV_ICON = new Map<string, React.ReactNode>([
  [
    "/today",
    navSvg(
      <>
        <circle cx="12" cy="12" r="4" />
        <line x1="12" y1="2" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="2" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </>,
    ),
  ],
  [
    "/approvals",
    navSvg(
      <>
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </>,
    ),
  ],
  ["/chats", navSvg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />)],
  [
    "/roster",
    navSvg(
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>,
    ),
  ],
  [
    "/logs",
    navSvg(
      <>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </>,
    ),
  ],
  ["/audit", navSvg(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />)],
  [
    "/settings/mcp",
    navSvg(
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>,
    ),
  ],
  [
    "/settings/custom-scripts",
    navSvg(
      <>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </>,
    ),
  ],
  [
    "/settings/access",
    navSvg(
      <>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>,
    ),
  ],
  [
    "/settings/notifications",
    navSvg(
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </>,
    ),
  ],
]);

const SIGN_OUT_ICON = navSvg(
  <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </>,
);

function DesktopNavLink({ item, pathname, pending }: { item: NavItem; pathname: string | null; pending: number }) {
  const active = pathname?.startsWith(item.href) ?? false;
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-current={active ? "page" : undefined}
      className={`${SHELL_LAYOUT.desktopNavItem} border-l-2`}
      style={{
        borderLeftColor: active ? "var(--accent)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-muted)",
        fontWeight: active ? 500 : 400,
      }}
    >
      <span className="flex-none" style={{ color: active ? "var(--accent)" : undefined }}>
        {NAV_ICON.get(item.href)}
      </span>
      <span className={`flex-1 truncate ${SHELL_LAYOUT.desktopLabel}`}>{item.label}</span>
      {item.href === "/approvals" && pending > 0 && (
        <span
          className={`min-w-[20px] rounded-full px-1.5 py-0.5 text-center font-mono text-[11px] font-medium ${SHELL_LAYOUT.desktopLabel}`}
          style={{ background: "var(--warning)", color: "var(--accent-fg)" }}
        >
          {pending}
        </span>
      )}
    </Link>
  );
}

/** Draws the brass mark + an amber dot (when approvals are pending) onto a
 * canvas and swaps it in as the favicon — the tab is the one place a count
 * is visible even when RetinueOS isn't the focused window. */
function useFavicon(pending: number) {
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#8a6a2f";
    ctx.beginPath();
    ctx.roundRect(2, 2, 28, 28, 7);
    ctx.fill();
    ctx.strokeStyle = "#f7f5f1";
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.moveTo(12.5, 13.5);
    ctx.lineTo(14.5, 18);
    ctx.moveTo(19.5, 13.5);
    ctx.lineTo(17.5, 18);
    ctx.stroke();
    ctx.fillStyle = "#f7f5f1";
    for (const [x, y] of [
      [11, 11.5],
      [21, 11.5],
      [16, 21],
    ]) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pending > 0) {
      ctx.fillStyle = "#9a6b12";
      ctx.beginPath();
      ctx.arc(25, 7, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#f7f5f1";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = canvas.toDataURL("image/png");
  }, [pending]);
}

function ChromelessShell({
  children,
  notifications,
}: {
  children: React.ReactNode;
  notifications: NotificationsValue;
}) {
  // /notifications (and any other route that reads the live snapshot) still
  // renders as `children` while auth chrome is gated off. Without a provider
  // here the page would stick on the context default — an empty list.
  return (
    <ToastProvider>
      <NotificationsProvider value={notifications}>{children}</NotificationsProvider>
    </ToastProvider>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  // whether we've confirmed a stored password exists at all, on
  // this mount / since the last time we were on a signed-out route. Starts
  // false on both server and client so hydration matches; the effect below
  // settles it before the chrome below ever paints, rather than after
  // per-page effects notice and redirect.
  const [authed, setAuthed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const online = useOnlineStatus();
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => getLastSyncedAt());
  const { keyboardOpen } = useKeyboardInset();

  const signedOut = pathname === "/login" || pathname === "/";
  // Unknown (still loading) reads as ready so the gate doesn't flash on
  // every navigation — the poll below settles it within one request.
  const blocked = status !== null && !status.ready;
  const pendingApprovals = usePendingApprovalsLive(client, !signedOut && Boolean(getStoredPassword()));
  const pending = pendingApprovals.pending.length;
  const notifications = useNotificationsLive(client, !signedOut && Boolean(getStoredPassword()));

  const refresh = useCallback(() => {
    if (signedOut || !getStoredPassword()) return;
    client.listPersonas().then(
      (list) => {
        setPersonas(list);
        // any successful reach-the-backend counts as a sync, not just
        // the routes the service worker shells -- this is the timestamp the
        // offline banner shows once we go offline.
        const now = Date.now();
        recordSync(now);
        setLastSyncedAt(now);
      },
      () => {},
    );
    setCheckingStatus(true);
    client
      .getConfig()
      .then(setStatus, () => {})
      .finally(() => setCheckingStatus(false));
  }, [client, signedOut]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // settle `authed` before the chrome below can render it, so a
  // signed-out launch of an app route (not /login) never paints the
  // sidebar/nav even for one frame -- previously only each page's own
  // `load()` effect checked auth, after the shell chrome around it had
  // already committed. Re-runs when coming back from a signed-out route
  // (e.g. right after /login sets the password) but not on every in-app
  // navigation once authed is confirmed true, so it doesn't re-hide the
  // chrome on ordinary route changes.
  useEffect(() => {
    if (signedOut || authed) return;
    setAuthed(Boolean(getStoredPassword()));
    setAuthChecked(true);
  }, [signedOut, authed]);

  useEffect(() => {
    registerServiceWorker();
  }, []);

  useFavicon(signedOut ? 0 : pending);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDispatchOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Covers /login and / (always chromeless), plus a fresh mount or a
  // confirmed-signed-out app route: never paint the sidebar/nav until
  // we've confirmed a stored password exists. `children` still renders --
  // each page's own `load()` effect redirects to /login in that case, or
  // (once the auth-check effect above flips `authed` true) this stops
  // matching and the real chrome renders on the next tick.
  if (!shouldRenderChrome({ signedOut, authChecked, authed })) {
    return <ChromelessShell notifications={notifications}>{children}</ChromelessShell>;
  }

  function signOut() {
    clearStoredPassword();
    router.push("/login");
  }

  if (blocked) {
    return (
      <ToastProvider>
        <SetupRequired onRetry={refresh} checking={checkingStatus} onSignOut={signOut} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <NotificationsProvider value={notifications}>
        <PendingApprovalsProvider value={pendingApprovals}>
          <NotificationToasts />
          <div className="flex min-h-screen">
            <a
              href="#main-content"
              className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-button bg-fg px-3 py-2 font-sans text-sm text-bg transition-transform focus:translate-y-0"
            >
              Skip to content
            </a>
            {/* md-shell-lg: icon-only, 64px. shell-lg+: full 240px with
              labels (design doc §05's middle breakpoint tier). */}
            <aside
              className="fixed inset-y-0 left-0 z-40 hidden w-16 flex-col gap-1 border-r p-3 md:flex shell-lg:w-[240px]"
              style={{ background: "var(--surface-sunken)", borderColor: "var(--border)" }}
            >
              <div className="flex items-center justify-center gap-2.5 px-2.5 pb-5 pt-2 text-accent shell-lg:justify-start">
                <BrandMark size={24} title="RetinueOS mark" />
                <span className={`font-serif text-[19px] ${SHELL_LAYOUT.desktopLabel}`} style={{ color: "var(--fg)" }}>
                  RetinueOS
                </span>
                <span className="ml-auto hidden shell-lg:block">
                  <NotificationBell client={client} personas={personas} />
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDispatchOpen(true)}
                title="Ask someone to…"
                aria-label="Ask someone to…"
                className={SHELL_LAYOUT.desktopAsk}
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                <span className="text-[15px] leading-none">+</span>
                <span className={SHELL_LAYOUT.desktopLabel}>Ask someone to&hellip;</span>
              </button>
              <span
                className={`px-3 pb-1.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-faint ${SHELL_LAYOUT.desktopLabel}`}
              >
                The house
              </span>
              {PRIMARY_NAV.map((item) => (
                <DesktopNavLink key={item.href} item={item} pathname={pathname} pending={pending} />
              ))}
              <span
                className={`px-3 pb-1.5 pt-4 font-mono text-[10px] uppercase tracking-wider text-fg-faint ${SHELL_LAYOUT.desktopLabel}`}
              >
                Settings
              </span>
              {SETTINGS_NAV.map((item) => (
                <DesktopNavLink key={item.href} item={item} pathname={pathname} pending={pending} />
              ))}
              <div className="mt-auto flex flex-col gap-0.5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
                <span className={`px-3 py-2 font-sans text-[13px] text-fg-faint ${SHELL_LAYOUT.desktopLabel}`}>
                  Theme · auto
                </span>
                <button
                  type="button"
                  onClick={signOut}
                  title="Sign out"
                  aria-label="Sign out"
                  className={SHELL_LAYOUT.desktopSignOut}
                >
                  <span className="flex-none">{SIGN_OUT_ICON}</span>
                  <span className={SHELL_LAYOUT.desktopLabel}>Sign out</span>
                </button>
              </div>
            </aside>

            {/* Mobile bottom bar — exactly five tabs; thumb-height
              targets, clear of the home indicator. Ask floats above it
              (below) rather than taking a sixth slot. Both hide while the
              keyboard is up: neither is reachable under it, and
              the bar's 52px is scarce space a keyboard-open chat needs
              for the composer/last message instead. */}
            <header
              className="fixed inset-x-0 top-0 z-30 flex h-11 items-center justify-between border-b px-3 md:hidden"
              style={{ background: "var(--surface)", borderColor: "var(--border)" }}
            >
              <Link href="/today" aria-label="RetinueOS home" className="text-accent">
                <BrandMark size={25} />
              </Link>
              <NotificationBell client={client} personas={personas} />
            </header>
            <MobileNav
              pathname={pathname}
              pending={pending}
              moreOpen={moreOpen}
              onMoreClick={() => setMoreOpen(true)}
              hidden={keyboardOpen}
            />

            {!keyboardOpen && (
              <button
                type="button"
                onClick={() => setDispatchOpen(true)}
                className={SHELL_LAYOUT.mobileAsk}
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                <span className="text-[15px] leading-none">+</span> Ask
              </button>
            )}

            <main id="main-content" className={SHELL_LAYOUT.main}>
              <OfflineBanner online={online} lastSyncedAt={lastSyncedAt} />
              {children}
            </main>
          </div>
          <DispatchDialog
            open={dispatchOpen}
            onClose={() => setDispatchOpen(false)}
            client={client}
            personas={personas}
          />
          <InstallPrompt />
          <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More" anchor="right">
            <div className="flex flex-col gap-0.5 p-2">
              {MORE_NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={SHELL_LAYOUT.moreRow}
                  style={{ color: "var(--fg)" }}
                >
                  {item.label}
                </Link>
              ))}
              <div className="mt-2 flex flex-col gap-0.5 border-t pt-2" style={{ borderColor: "var(--border)" }}>
                <span className={`${SHELL_LAYOUT.moreRow} text-fg-faint`}>Theme · auto</span>
                <button
                  type="button"
                  onClick={signOut}
                  className={SHELL_LAYOUT.moreRow}
                  style={{ color: "var(--danger)" }}
                >
                  Sign out
                </button>
              </div>
            </div>
          </Sheet>
        </PendingApprovalsProvider>
      </NotificationsProvider>
    </ToastProvider>
  );
}
