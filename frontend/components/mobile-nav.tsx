"use client";

import Link from "next/link";
import { SHELL_LAYOUT } from "@/lib/touch-layout";
import { MOBILE_TABS } from "@/lib/nav";

/**
 * The five-tab bottom bar, split out of AppShell so `hidden` --
 * whether the on-screen keyboard is covering it -- can be locked
 * with a render test without mounting the whole shell (ApiClient, SSE
 * polling, router context), matching how lib/nav.ts was split out for the
 * same reason. Renders nothing at all while hidden rather than a
 * `display:none` class: the bar is unreachable under the keyboard anyway,
 * and its 52px would otherwise still count against the now-scarce
 * viewport in the flex column it sits in.
 */
export function MobileNav({
  pathname,
  pending,
  moreOpen,
  onMoreClick,
  hidden,
}: {
  pathname: string | null;
  pending: number;
  moreOpen: boolean;
  onMoreClick: () => void;
  hidden: boolean;
}) {
  if (hidden) return null;

  return (
    <nav className={SHELL_LAYOUT.mobileNav} style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
      {MOBILE_TABS.map((tab) => {
        if (tab.kind === "more") {
          return (
            <button
              key="more"
              type="button"
              onClick={onMoreClick}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={SHELL_LAYOUT.mobileNavItem}
              style={{ color: moreOpen ? "var(--accent)" : "var(--fg-muted)" }}
            >
              <span className="max-w-full truncate">{tab.label}</span>
            </button>
          );
        }
        const active = pathname?.startsWith(tab.href);
        const showDot = tab.href === "/approvals" && pending > 0;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            aria-label={showDot ? `${tab.label}, ${pending} pending approval${pending === 1 ? "" : "s"}` : tab.label}
            className={SHELL_LAYOUT.mobileNavItem}
            style={{ color: active ? "var(--accent)" : "var(--fg-muted)" }}
          >
            <span className="max-w-full truncate">{tab.mobileLabel}</span>
            {/* Below md, Approvals gets a dot -- the exact pending count
                lives on the favicon and Today (design doc §05). */}
            {showDot && (
              <span
                aria-hidden="true"
                className="absolute right-2.5 top-2 h-2 w-2 rounded-full"
                style={{ background: "var(--warning)" }}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
