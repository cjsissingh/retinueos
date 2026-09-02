"use client";

import type { NotificationKind, NotificationPreference } from "@/lib/api-client";
import { KIND_LABELS } from "@/lib/notification-kinds";
import { Toggle } from "./ui/toggle";

const FORCED_IN_APP_KINDS: ReadonlySet<NotificationKind> = new Set([
  "approval_needed",
  "question",
  "job_failed",
  "connector_broke",
]);

const DIGEST_APPLICABLE_KINDS: ReadonlySet<NotificationKind> = new Set(["job_finished", "routine_ran"]);

type PreferencePatch = Partial<Pick<NotificationPreference, "inAppEnabled" | "pushEnabled" | "digestEnabled">>;

function Channel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 sm:justify-center">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint sm:hidden">{label}</span>
      {children}
    </div>
  );
}

export function NotificationMatrixTable({
  preferences,
  onChange,
}: {
  preferences: NotificationPreference[];
  onChange: (kind: NotificationKind, patch: PreferencePatch) => void;
}) {
  return (
    <div className="font-sans text-[13px]">
      <div className="hidden grid-cols-[minmax(0,1fr)_88px_88px_88px] border-b pb-2 sm:grid">
        {["Event", "In-app", "Push", "Digest"].map((label, index) => (
          <span
            key={label}
            className={`font-mono text-[10px] uppercase tracking-wider text-fg-faint ${index === 0 ? "text-left" : "text-center"}`}
          >
            {label}
          </span>
        ))}
      </div>
      {preferences.map((pref) => {
        const label = KIND_LABELS[pref.kind];
        const forced = FORCED_IN_APP_KINDS.has(pref.kind);
        const digestApplies = DIGEST_APPLICABLE_KINDS.has(pref.kind);
        return (
          <div key={pref.kind} className="border-b py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_88px_88px_88px] sm:py-2">
            <p className="m-0 mb-1 font-medium text-fg sm:mb-0 sm:flex sm:items-center">{label}</p>
            <Channel label="In-app">
              {forced ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">Required</span>
              ) : (
                <Toggle
                  checked={pref.inAppEnabled}
                  onChange={(checked) => onChange(pref.kind, { inAppEnabled: checked })}
                  label={`${label} in-app`}
                />
              )}
            </Channel>
            <Channel label="Push">
              <Toggle
                checked={pref.pushEnabled}
                onChange={(checked) => onChange(pref.kind, { pushEnabled: checked })}
                label={`${label} push`}
              />
            </Channel>
            <Channel label="Digest">
              {digestApplies ? (
                <Toggle
                  checked={pref.digestEnabled}
                  onChange={(checked) => onChange(pref.kind, { digestEnabled: checked })}
                  label={`${label} digest`}
                />
              ) : (
                <span className="text-fg-faint">—</span>
              )}
            </Channel>
          </div>
        );
      })}
    </div>
  );
}
