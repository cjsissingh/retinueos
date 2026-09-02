"use client";

import { useState } from "react";
import type { ActivityPill } from "@/lib/activity-pill";
import { toolCallTranscriptEntry } from "@/lib/activity-pill";
import { TranscriptRow } from "./transcript-row";
import { displayEnum } from "@/lib/display";

/** A merged run of tool calls in the persona chat transcript --
 *  collapsed to one row so a chat reads as a conversation, not a tool log.
 *  Expanding it shows the exact same `TranscriptRow`s the calls would have
 *  rendered as individually, so nothing is lost by collapsing. */
export function ActivityPillRow({ pill }: { pill: ActivityPill }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="flex min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-button border-0 bg-transparent px-0 py-1 text-left"
      >
        <span className="min-w-0 truncate font-mono text-xs text-fg-faint">
          {displayEnum(pill.connector)} · {pill.summary} · {pill.count}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-none text-fg-faint"
          style={{ transform: expanded ? "rotate(90deg)" : "none" }}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {expanded && (
        <div
          className="mt-2 flex min-w-0 max-w-full flex-col gap-3 border-l pl-3"
          style={{ borderColor: "var(--border)" }}
        >
          {pill.calls.map((toolCall) => (
            // unframed, matching the rest of the chat transcript --
            // every call in a pill is non-failed by construction (a failed
            // call breaks the run in groupTimelineForPills), so there's no
            // danger frame to preserve here the way there is for a
            // standalone tool_call row.
            <TranscriptRow key={toolCall.id} framed={false} entry={toolCallTranscriptEntry(toolCall)} />
          ))}
        </div>
      )}
    </div>
  );
}
