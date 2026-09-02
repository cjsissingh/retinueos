"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApiClient, Persona } from "@/lib/api-client";
import { isNeedsYou } from "@/lib/notification-kinds";
import { useNotifications } from "@/lib/use-notifications";
import { NotificationList } from "./notification-list";
import { PushNudgeStrip } from "./push-nudge-strip";
import { Sheet } from "./ui/sheet";

function BellIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function NotificationBell({
  client,
  personas,
  initiallyOpen = false,
}: {
  client: ApiClient;
  personas: Persona[];
  /** Test-only: Sheet returns null while closed, so SSR tests pass true. */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [filter, setFilter] = useState<"needs_you" | "all">("needs_you");
  const { items, unreadNeedsYouCount } = useNotifications();
  const filtered = filter === "needs_you" ? items.filter(isNeedsYou) : items;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unreadNeedsYouCount > 0 ? `Notifications, ${unreadNeedsYouCount} need you` : "Notifications"}
        className="relative grid h-11 w-11 flex-none place-items-center rounded-button border-0 bg-transparent text-fg-muted"
      >
        <BellIcon />
        {unreadNeedsYouCount > 0 && (
          <span
            className="absolute right-1.5 top-1.5 min-w-[16px] rounded-full bg-warning px-1 text-center font-mono text-[10px] leading-4 text-accent-fg"
            aria-hidden="true"
          >
            {unreadNeedsYouCount}
          </span>
        )}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        anchor="popover"
        title="Notifications"
        footer={
          <div className="flex items-center justify-between font-sans text-[13px]">
            <Link href="/notifications" onClick={() => setOpen(false)} className="text-fg-muted no-underline">
              See all
            </Link>
            <Link href="/settings/notifications" onClick={() => setOpen(false)} className="text-fg-muted no-underline">
              Notification settings
            </Link>
          </div>
        }
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFilter("needs_you")}
              aria-pressed={filter === "needs_you"}
              className="min-h-11 flex-none rounded-full border px-3 font-sans text-[13px]"
              style={{
                borderColor: filter === "needs_you" ? "var(--accent-soft-border)" : "var(--border)",
                background: filter === "needs_you" ? "var(--accent-soft)" : "transparent",
                color: filter === "needs_you" ? "var(--accent-soft-fg)" : "var(--fg-muted)",
              }}
            >
              Needs you · {unreadNeedsYouCount}
            </button>
            <button
              type="button"
              onClick={() => setFilter("all")}
              aria-pressed={filter === "all"}
              className="min-h-11 flex-none rounded-full border px-3 font-sans text-[13px]"
              style={{
                borderColor: filter === "all" ? "var(--accent-soft-border)" : "var(--border)",
                background: filter === "all" ? "var(--accent-soft)" : "transparent",
                color: filter === "all" ? "var(--accent-soft-fg)" : "var(--fg-muted)",
              }}
            >
              All
            </button>
          </div>
          <button
            type="button"
            onClick={() => client.markAllNotificationsRead()}
            className="min-h-11 flex-none font-sans text-[13px] text-fg-muted underline"
          >
            Mark all read
          </button>
        </div>
        <PushNudgeStrip client={client} />
        <NotificationList client={client} items={filtered} personas={personas} onActed={() => {}} />
      </Sheet>
    </div>
  );
}
