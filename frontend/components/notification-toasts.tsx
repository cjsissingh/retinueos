"use client";

import { useEffect, useRef } from "react";
import { isNeedsYou } from "@/lib/notification-kinds";
import { notificationToastHref, reconcileSeen } from "@/lib/toast-rules";
import { useNotifications } from "@/lib/use-notifications";
import { useToast } from "./toast";

/** Ephemeral twin of the centre: toast each newly arrived row once the
 *  first snapshot has primed so a page load doesn't replay history --
 *  see reconcileSeen's own header comment for why priming waits on `ready`. */
export function NotificationToasts() {
  const { items, ready } = useNotifications();
  const { showToast } = useToast();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const result = reconcileSeen(seen.current, ready, items);
    seen.current = result.seen;
    for (const item of result.arrived) {
      showToast(item.title, { href: notificationToastHref(item), persist: isNeedsYou(item) });
    }
  }, [items, ready, showToast]);

  return null;
}
