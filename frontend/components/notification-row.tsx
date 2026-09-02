"use client";

import { useState } from "react";
import { ApiClient, type NotificationRow as NotificationRowType, type Persona } from "@/lib/api-client";
import { delegatedChatHref } from "@/lib/chat-navigation";
import { PersonaAvatar } from "./persona-avatar";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function NotificationRow({
  client,
  notification,
  persona,
  onActed,
}: {
  client: ApiClient;
  notification: NotificationRowType;
  persona?: Persona;
  onActed: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const unread = notification.readAt === null;
  const showActions = notification.kind === "approval_needed" && notification.toolCallId && !notification.actedAt;

  async function approve() {
    if (!notification.toolCallId) return;
    setBusy(true);
    try {
      // Same call ApprovalItem's resolve() makes (components/approval-item.tsx)
      // -- this row is an ephemeral, compact twin of that card, not a second
      // implementation of what "approve" means.
      await client.approveToolCall(notification.toolCallId);
      onActed(notification.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex min-h-11 gap-2.5 rounded-button p-3"
      style={{ background: unread ? "var(--surface-sunken)" : "transparent" }}
      onClick={() => {
        if (unread) void client.markNotificationRead(notification.id);
      }}
    >
      <span className="flex w-4 flex-none items-start justify-center pt-1.5">
        {unread && <i aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />}
      </span>
      <span className="flex-none">
        {persona ? (
          <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
        ) : (
          <i aria-hidden="true" className="block h-6 w-6 rounded-full bg-neutral-soft" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 font-sans text-[13px] font-medium leading-snug text-fg">{notification.title}</p>
        <p className="m-0 mt-0.5 line-clamp-2 font-sans text-[13px] leading-snug text-fg-muted">{notification.body}</p>
        <p className="m-0 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
          {relativeTime(notification.createdAt)}
        </p>
        {showActions && (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={approve}
              className="min-h-11 rounded-button border-0 px-3.5 font-sans text-[13px] font-medium disabled:opacity-50"
              style={{ background: "var(--success)", color: "var(--accent-fg)" }}
            >
              {busy ? "Working…" : "Approve"}
            </button>
            <a
              href={
                notification.personaId && notification.jobId
                  ? delegatedChatHref({ id: notification.jobId, personaId: notification.personaId })
                  : `/logs/${notification.jobId}`
              }
              className="inline-flex min-h-11 items-center rounded-button border px-3.5 font-sans text-[13px]"
              style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
            >
              Open
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
