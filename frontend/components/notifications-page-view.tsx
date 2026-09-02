"use client";

import type { ApiClient, NotificationRow, Persona } from "@/lib/api-client";
import { PageHeader } from "@/components/page-header";
import { NotificationList } from "@/components/notification-list";
import { PushNudgeStrip } from "@/components/push-nudge-strip";
import { PAGE_PAD } from "@/lib/touch-layout";

export function NotificationsPageView({
  client,
  items,
  personas,
}: {
  client: ApiClient;
  items: NotificationRow[];
  personas: Persona[];
}) {
  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow="Inbox"
        title="Notifications"
        description="Decisions, questions, and outcomes from across the house."
      />
      <div className="max-w-[680px]">
        <PushNudgeStrip client={client} />
        <NotificationList client={client} items={items} personas={personas} onActed={() => {}} />
      </div>
    </main>
  );
}
