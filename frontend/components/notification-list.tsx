"use client";

import type { ApiClient, NotificationRow as NotificationRowType, Persona } from "@/lib/api-client";
import { isNeedsYou } from "@/lib/notification-kinds";
import { NotificationRow } from "./notification-row";

function isToday(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export interface GroupedNotifications {
  pinned: NotificationRowType[];
  earlierToday: NotificationRowType[];
  days: { label: string; items: NotificationRowType[] }[];
}

/**
 * Pure grouping (design doc §04's popover layout): unacted needs-you rows
 * pin to the top regardless of age; everything else buckets by "earlier
 * today" vs. a day group. `now` is a parameter (not `new Date()` inline) so
 * this stays unit-testable without faking the clock.
 */
export function groupNotifications(items: NotificationRowType[], now: Date = new Date()): GroupedNotifications {
  const pinned = items.filter((item) => isNeedsYou(item) && item.actedAt === null);
  const rest = items.filter((item) => !pinned.includes(item));
  const earlierToday = rest.filter((item) => isToday(item.createdAt, now));
  const older = rest.filter((item) => !isToday(item.createdAt, now));

  const dayBuckets = new Map<string, NotificationRowType[]>();
  for (const item of older) {
    const key = new Date(item.createdAt).toDateString();
    const bucket = dayBuckets.get(key) ?? [];
    bucket.push(item);
    dayBuckets.set(key, bucket);
  }
  const days: { label: string; items: NotificationRowType[] }[] = [];
  for (const [, dayItems] of dayBuckets.entries()) {
    const first = dayItems[0];
    if (!first) continue;
    days.push({ label: dayLabel(first.createdAt), items: dayItems });
  }

  return { pinned, earlierToday, days };
}

function findPersona(personas: Persona[], id: string | null): Persona | undefined {
  return id ? personas.find((p) => p.id === id) : undefined;
}

export function NotificationList({
  client,
  items,
  personas,
  onActed,
}: {
  client: ApiClient;
  items: NotificationRowType[];
  personas: Persona[];
  onActed: (id: string) => void;
}) {
  const grouped = groupNotifications(items);
  const caughtUp = items.filter(isNeedsYou).length === 0;

  return (
    <div className="flex flex-col gap-4 p-2">
      {caughtUp && (
        <div className="py-6">
          <p className="m-0 font-serif text-lg text-fg">Nothing needs your attention.</p>
          <p className="m-0 mt-1 font-sans text-sm text-fg-muted">Recent outcomes stay below for reference.</p>
        </div>
      )}
      {grouped.pinned.length > 0 && (
        <section>
          <p className="m-0 mb-1 px-2 font-mono text-[10px] uppercase tracking-wider text-fg-faint">NEEDS YOU</p>
          <div className="flex flex-col gap-1">
            {grouped.pinned.map((item) => (
              <NotificationRow
                key={item.id}
                client={client}
                notification={item}
                persona={findPersona(personas, item.personaId)}
                onActed={onActed}
              />
            ))}
          </div>
        </section>
      )}
      {grouped.earlierToday.length > 0 && (
        <section>
          <p className="m-0 mb-1 px-2 font-mono text-[10px] uppercase tracking-wider text-fg-faint">Earlier today</p>
          <div className="flex flex-col gap-1">
            {grouped.earlierToday.map((item) => (
              <NotificationRow
                key={item.id}
                client={client}
                notification={item}
                persona={findPersona(personas, item.personaId)}
                onActed={onActed}
              />
            ))}
          </div>
        </section>
      )}
      {grouped.days.map((day) => (
        <section key={day.label}>
          <p className="m-0 mb-1 px-2 font-mono text-[10px] uppercase tracking-wider text-fg-faint">{day.label}</p>
          <div className="flex flex-col gap-1">
            {day.items.map((item) => (
              <NotificationRow
                key={item.id}
                client={client}
                notification={item}
                persona={findPersona(personas, item.personaId)}
                onActed={onActed}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
