"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient, ToolCall } from "./api-client";

/**
 * Fallback poll so a dropped EventSource that somehow never reconnects
 * cannot leave the badge and Approvals list stuck. Live updates still come
 * from GET /pending_approvals/stream; this is the same 15s cadence
 * app-shell used to rely on as its only source of truth.
 */
const FALLBACK_POLL_MS = 15_000;

export interface PendingApprovalsValue {
  pending: ToolCall[];
  /** Bumps when the pending id set changes, so roster/job views can refetch. */
  revision: number;
}

const PendingApprovalsContext = createContext<PendingApprovalsValue>({ pending: [], revision: 0 });

export function usePendingApprovals(): PendingApprovalsValue {
  return useContext(PendingApprovalsContext);
}

function pendingIdsKey(items: ToolCall[]): string {
  return items
    .map((item) => item.id)
    .sort()
    .join(",");
}

export function usePendingApprovalsLive(client: ApiClient, enabled: boolean): PendingApprovalsValue {
  const [pending, setPending] = useState<ToolCall[]>([]);
  const [revision, setRevision] = useState(0);
  const idsRef = useRef("");

  useEffect(() => {
    if (!enabled) {
      setPending([]);
      idsRef.current = "";
      return;
    }

    const apply = (items: ToolCall[]) => {
      setPending(items);
      const key = pendingIdsKey(items);
      if (key === idsRef.current) return;
      idsRef.current = key;
      setRevision((n) => n + 1);
    };

    client.listPendingToolCalls().then(apply, () => {});
    const unsubscribe = client.streamPendingApprovals(apply);
    const id = setInterval(() => {
      client.listPendingToolCalls().then(apply, () => {});
    }, FALLBACK_POLL_MS);
    return () => {
      unsubscribe();
      clearInterval(id);
    };
  }, [client, enabled]);

  return useMemo(() => ({ pending, revision }), [pending, revision]);
}

export function PendingApprovalsProvider({ value, children }: { value: PendingApprovalsValue; children: ReactNode }) {
  return <PendingApprovalsContext.Provider value={value}>{children}</PendingApprovalsContext.Provider>;
}
