"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient, NotificationRow } from "./api-client";
import { isNeedsYou } from "./notification-kinds";

/** Same fallback cadence as use-pending-approvals.tsx's FALLBACK_POLL_MS --
 *  a dropped EventSource that never reconnects must not leave the bell
 *  badge stuck. */
const FALLBACK_POLL_MS = 15_000;
const SNAPSHOT_LIMIT = 50;

export interface NotificationsValue {
  items: NotificationRow[];
  unreadNeedsYouCount: number;
  /** Bumps when the item id set changes, so dependent views can refetch. */
  revision: number;
  /**
   * True once the first real snapshot (fetch or stream) has landed. `items`
   * starts at `[]` before that -- a consumer that seeds its "already seen"
   * set off the first render rather than the first `ready` render (e.g. a
   * toast queue) would treat that pre-fetch emptiness as the truth and then
   * announce every existing row as newly arrived the moment real data shows
   * up, replaying history on every mount instead of only toasting what's
   * actually new (the "a page load doesn't replay history").
   */
  ready: boolean;
}

const NotificationsContext = createContext<NotificationsValue>({
  items: [],
  unreadNeedsYouCount: 0,
  revision: 0,
  ready: false,
});

export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext);
}

function idsKey(items: NotificationRow[]): string {
  return items
    .map((item) => `${item.id}:${item.readAt}:${item.actedAt}`)
    .sort()
    .join(",");
}

export function useNotificationsLive(client: ApiClient, enabled: boolean): NotificationsValue {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const keyRef = useRef("");

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setReady(false);
      keyRef.current = "";
      return;
    }

    const apply = (next: NotificationRow[]) => {
      setItems(next);
      setReady(true);
      const key = idsKey(next);
      if (key === keyRef.current) return;
      keyRef.current = key;
      setRevision((n) => n + 1);
    };

    client.listNotifications({ limit: SNAPSHOT_LIMIT }).then(
      (page) => apply(page.items),
      () => {},
    );
    const unsubscribe = client.streamNotifications(apply);
    const id = setInterval(() => {
      client.listNotifications({ limit: SNAPSHOT_LIMIT }).then(
        (page) => apply(page.items),
        () => {},
      );
    }, FALLBACK_POLL_MS);
    return () => {
      unsubscribe();
      clearInterval(id);
    };
  }, [client, enabled]);

  return useMemo(
    () => ({ items, unreadNeedsYouCount: items.filter(isNeedsYou).length, revision, ready }),
    [items, revision, ready],
  );
}

export function NotificationsProvider({ value, children }: { value: NotificationsValue; children: ReactNode }) {
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
