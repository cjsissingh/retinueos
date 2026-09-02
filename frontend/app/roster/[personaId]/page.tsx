"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ApiClient, ApiError, type Job, type Persona } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { composerState } from "@/lib/chat-composer-state";
import { PersonaAvatar } from "@/components/persona-avatar";
import { MarkdownContent } from "@/components/markdown-content";
import { PersonaStatusBadge, derivePersonaStatus } from "@/components/status-badge";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { ApprovalItem } from "@/components/approval-item";
import { TranscriptRow } from "@/components/transcript-row";
import { ActivityPillRow } from "@/components/activity-pill";
import { groupTimelineForPills, toolCallTranscriptEntry, type TimelineEntry } from "@/lib/activity-pill";
import { Sheet } from "@/components/ui/sheet";
import { useJobTranscript } from "@/lib/use-job-transcript";
import { shouldSubmitChatComposer } from "@/lib/chat-composer";
import { chatTitle } from "@/lib/chat-title";
import { selectRequestedChat } from "@/lib/chat-navigation";
import { DelegationCard } from "@/components/delegation-card";
import { NotificationIntentControl } from "@/components/notification-intent-control";
import { getStoredNotifyPreference, setStoredNotifyPreference } from "@/lib/notify-preference";
import { PERSONA_CHAT_LAYOUT, keyboardAwarePageStyle } from "@/lib/persona-chat-layout";
import { LIST_ROW, PAGE_PAD, SECONDARY_BUTTON, TOUCH_TARGET } from "@/lib/touch-layout";
import { useOnlineStatus } from "@/lib/use-online-status";
import { usePendingApprovals } from "@/lib/use-pending-approvals";
import { useToast } from "@/components/toast";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { bottomScrollTop, isNearBottom } from "@/lib/scroll-anchor";
import { displayModelName } from "@/lib/display";

type LoadState = "loading" | "ready" | "error" | "not_found";

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The chats list -- shared between the permanent desktop column and the
 * mobile `Sheet` opened from the header's "Chats" action, so
 * there's exactly one implementation of "pick a chat" rather than a
 * bespoke mobile variant. `showEyebrow` is false inside the Sheet, whose
 * own header already carries the "Chats" title.
 */
function ChatsListBody({
  jobs,
  activeJobId,
  onSelect,
  onNew,
  showEyebrow,
}: {
  jobs: Job[];
  activeJobId: string | null;
  onSelect: (jobId: string) => void;
  onNew: () => void;
  showEyebrow: boolean;
}) {
  return (
    <>
      <div className="flex flex-none items-center justify-between px-4 pb-3 pt-4">
        {showEyebrow ? (
          <span className="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Chats</span>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onNew}
          className="inline-flex min-h-11 items-center gap-1 rounded-button border px-2.5 font-sans text-xs"
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New
        </button>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {jobs.length === 0 && <p className="px-1.5 py-2 font-sans text-[13px] text-fg-muted">No chats yet.</p>}
        {jobs.map((job) => {
          const active = job.id === activeJobId;
          return (
            <button
              key={job.id}
              type="button"
              onClick={() => onSelect(job.id)}
              className={`${LIST_ROW} mb-1 block w-full rounded-button border px-2.5 py-2 text-left`}
              style={{
                background: active ? "var(--accent-soft)" : "transparent",
                borderColor: active ? "var(--accent-soft-border)" : "transparent",
              }}
            >
              <span className="flex items-center justify-between gap-1.5">
                <span className="truncate font-sans text-[13px]" style={{ color: "var(--fg)" }}>
                  {chatTitle(job)}
                </span>
                <span className="flex-none font-mono text-[10px] text-fg-faint">{relativeTime(job.updatedAt)}</span>
              </span>
              {job.routineId && (
                <span
                  className="mt-1 inline-flex items-center gap-1 rounded-badge px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                  style={{ color: "var(--accent-soft-fg)", background: "var(--accent-soft)" }}
                >
                  Routine
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex-none border-t px-4 pb-3.5 pt-2.5" style={{ borderColor: "var(--border)" }}>
        <p className="m-0 font-sans text-[11px] leading-relaxed text-fg-faint">
          Chats close after a while to keep replies sharp — start a new one anytime.
        </p>
      </div>
    </>
  );
}

function PersonaDetailContent() {
  const params = useParams<{ personaId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedChatId = searchParams.get("chat");
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );

  const [persona, setPersona] = useState<Persona | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allPersonas, setAllPersonas] = useState<Persona[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  // AppShell hides the tab bar/Ask pill on `keyboardOpen` itself; this page
  // only needs the occlusion height, to shrink the page and keep the
  // composer above the keyboard.
  const { inset: keyboardInset } = useKeyboardInset();
  // Whether the reader was following the latest message when the
  // transcript last scrolled -- read (not `useState`) so updating it on
  // every scroll event doesn't itself trigger a render.
  const stickToBottomRef = useRef(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const { pending: workspacePending, revision } = usePendingApprovals();
  const pendingApprovals = useMemo(
    () => (activeJobId ? workspacePending.filter((tc) => tc.jobId === activeJobId) : []),
    [workspacePending, activeJobId],
  );

  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // the chip's checked state, not just its visibility, is sticky --
  // it remembers the last choice made for *this persona* (see
  // lib/notify-preference.ts) rather than resetting to unchecked every time
  // a message sends or the chat reopens.
  const [notifyOnOutcome, setNotifyOnOutcomeState] = useState(false);
  const setNotifyOnOutcome = useCallback(
    (checked: boolean) => {
      setNotifyOnOutcomeState(checked);
      setStoredNotifyPreference(params.personaId, checked);
    },
    [params.personaId],
  );
  // a message that was being sent when connectivity dropped.
  // The composer itself is disabled while offline (composerDisabled
  // below), so this only ever gets set from submit()'s catch -- not from
  // a user-triggered send while already known offline.
  const [queuedMessage, setQueuedMessage] = useState<{
    text: string;
    notify: boolean;
    idempotencyKey: string;
  } | null>(null);
  const online = useOnlineStatus();
  const { showToast } = useToast();
  const [pushDeviceCount, setPushDeviceCount] = useState<number | null>(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [retryingJob, setRetryingJob] = useState(false);

  const [chatsOpen, setChatsOpen] = useState(false);

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [jobs],
  );

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [p, j, all] = await Promise.all([
        client.getPersona(params.personaId),
        client.listJobs(params.personaId),
        client.listPersonas(),
      ]);
      setPersona(p);
      setJobs(j);
      setAllPersonas(all);
      setState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      if (err instanceof ApiError && err.status === 404) {
        setState("not_found");
        return;
      }
      setState("error");
    }
  }, [client, params.personaId, router]);

  useEffect(() => {
    if (state !== "ready") return;
    setActiveJobId(selectRequestedChat(jobs, requestedChatId));
  }, [jobs, requestedChatId, state]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
    client.getPushConfig().then(
      (config) => setPushDeviceCount(config.deviceCount),
      () => setPushDeviceCount(0),
    );
  }, [client, load, router]);

  useEffect(() => {
    if (revision === 0 || !getStoredPassword()) return;
    client.listJobs(params.personaId).then(setJobs, () => {});
  }, [revision, client, params.personaId]);

  // Loads this persona's remembered notify choice on mount and whenever
  // the route's personaId changes -- e.g. picking a different report from
  // the org chart without a full page reload.
  useEffect(() => {
    setNotifyOnOutcomeState(getStoredNotifyPreference(params.personaId));
  }, [params.personaId]);

  // Messages + resolved tool calls, merged by createdAt -- the historical
  // view GET /jobs/:id/messages and GET /tool_calls?jobId= together make
  // possible now that `job.transcript` is gone (schema.ts's messages doc
  // comment). Still-pending tool calls are excluded here: those render via
  // the separate ApprovalItem list below, not interleaved into history.
  const loadTimeline = useCallback(
    (jobId: string) => {
      Promise.all([client.listMessages(jobId), client.listToolCallsForJob(jobId), client.listChildJobs(jobId)])
        .then(([messages, toolCalls, childJobs]) => {
          const entries: TimelineEntry[] = [
            ...messages.map((m): TimelineEntry => ({ kind: "message", at: m.createdAt, message: m })),
            ...toolCalls
              .filter((tc) => tc.status !== "pending_approval")
              .map((tc): TimelineEntry => ({ kind: "tool_call", at: tc.createdAt, toolCall: tc })),
            ...childJobs.map((job): TimelineEntry => ({ kind: "delegation", at: job.createdAt, job })),
          ];
          entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
          setTimeline(entries);
        })
        .catch(() => {});
    },
    [client],
  );

  const pendingKey = pendingApprovals
    .map((tc) => tc.id)
    .sort()
    .join(",");

  // Selecting a chat (or landing on one after load) fetches its full row --
  // sortedJobs only carries what GET /jobs returns for the list, and a chat
  // just continued elsewhere (another tab, a routine firing) could be
  // stale by the time it's clicked.
  useEffect(() => {
    // A freshly selected chat always opens pinned to its latest message,
    // not whatever the previously open chat's scroll position left behind.
    stickToBottomRef.current = true;
    if (!activeJobId) {
      setActiveJob(null);
      setTimeline([]);
      return;
    }
    let cancelled = false;
    client.getJob(activeJobId).then((j) => {
      if (!cancelled) setActiveJob(j);
    });
    loadTimeline(activeJobId);
    return () => {
      cancelled = true;
    };
  }, [activeJobId, client, loadTimeline]);

  // The per-job transcript stream ends at waiting_approval, so a resolve
  // on another device never reaches this view that way. When this job's
  // pending ids change, refetch the job so the chat can leave (or enter)
  // waiting_approval and reconnect the live stream.
  useEffect(() => {
    if (!activeJobId) return;
    client.getJob(activeJobId).then(
      (updated) => {
        setActiveJob(updated);
        setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
      },
      () => {},
    );
    if (pendingKey === "") loadTimeline(activeJobId);
  }, [pendingKey, activeJobId, client, loadTimeline]);

  const liveTranscript = useJobTranscript(
    client,
    activeJob,
    activeJob !== null,
    (updated) => {
      setActiveJob(updated);
      setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
      // A status transition (most importantly reaching done/failed/etc.)
      // is exactly when this turn's real messages/tool calls just landed.
      if (activeJobId) loadTimeline(activeJobId);
    },
    () => {
      if (activeJobId) loadTimeline(activeJobId);
    },
  );

  // Keeps the transcript pinned to its latest message across new arrivals
  // and the keyboard opening/closing -- not `scrollIntoView`,
  // which jumps/animates and fights iOS Safari's own scroll-to-focused-
  // field behavior. Only restores scroll when the reader was already at
  // the bottom (handleTranscriptScroll below), so someone reading history
  // isn't yanked back down by an unrelated resize.
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = bottomScrollTop(el.scrollHeight, el.clientHeight);
    // `timeline`/`liveTranscript`/`keyboardInset` are read only as re-run
    // triggers, not inside this body (the scroll math above reads the DOM
    // node directly) -- same "extra dep on purpose" shape as
    // use-job-transcript.ts's own `status` dependency.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [timeline, liveTranscript, keyboardInset]);

  function handleTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  }

  // Shared by submit() (typed in this session) and the reconnect-retry
  // effect below -- both put a message on the wire the same way.
  // useCallback (rather than a plain function like the rest of this file's
  // handlers) because the retry effect below depends on it directly.
  const sendComposerText = useCallback(
    async (text: string, shouldNotify: boolean, idempotencyKey: string) => {
      if (!activeJob) {
        const created = await client.createJob(
          {
            personaId: params.personaId,
            prompt: text,
            notifyOnOutcome: shouldNotify,
          },
          idempotencyKey,
        );
        setJobs((prev) => [created, ...prev]);
        // Not setActiveJob(created) too -- the effect below (watching
        // activeJobId) already fetches and sets it. Writing it here as well
        // raced that fetch: whichever resolved second won, and a `getJob`
        // that happened to still be in flight from before this job settled
        // could stomp a status the SSE stream had already delivered,
        // leaving the chat visibly stuck on "running" until a reload.
        setActiveJobId(created.id);
        router.replace(`/roster/${encodeURIComponent(params.personaId)}?chat=${encodeURIComponent(created.id)}`, {
          scroll: false,
        });
      } else {
        const updated = await client.continueJob(activeJob.id, text, shouldNotify, idempotencyKey);
        setActiveJob(updated);
        setJobs((prev) => prev.map((j) => (j.id === updated.id ? updated : j)));
        // activeJobId itself doesn't change on a continue, so the effect
        // that normally loads the timeline on job selection won't re-fire --
        // without this, the message just sent wouldn't show until the live
        // stream's next update (a real trigger, but not an instant one).
        loadTimeline(updated.id);
      }
    },
    [activeJob, client, loadTimeline, params.personaId, router],
  );

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!composerText.trim() || sending) return;
    setSending(true);
    setSendError(null);
    const text = composerText.trim();
    // the chip stays as the operator left it (see
    // lib/notify-preference.ts) rather than snapping back to unchecked
    // after every send -- that's what makes it a remembered per-persona
    // choice instead of a one-shot toggle.
    const shouldNotify = notifyOnOutcome;
    // Minted here, not inside sendComposerText, so an offline retry
    // reuses the same key. The backend treats a repeated Idempotency-Key
    // as a replay, which is what stops a lost response from creating a
    // second job or a second continuation turn.
    const idempotencyKey = crypto.randomUUID();
    try {
      await sendComposerText(text, shouldNotify, idempotencyKey);
      setComposerText("");
    } catch (err) {
      if (!online) {
        // Connectivity dropped mid-send rather than this being a real
        // rejection -- hold onto it instead of showing a hard error; the
        // reconnect effect below retries it once when `online` flips back.
        setQueuedMessage({ text, notify: shouldNotify, idempotencyKey });
        setComposerText("");
      } else {
        setSendError(
          err instanceof ApiError ? (err.detail ?? `Couldn't send that (${err.status}).`) : "Couldn't send that.",
        );
      }
    } finally {
      setSending(false);
    }
  }

  // retries a message that dropped offline mid-send exactly once,
  // the moment connectivity returns -- not on a poll, and not repeatedly.
  // A second failure (still offline-flaky, or a real rejection this time)
  // surfaces as a toast rather than a silent drop, since the composer
  // already cleared the text on the first attempt.
  useEffect(() => {
    if (!online || !queuedMessage) return;
    const { text, notify, idempotencyKey } = queuedMessage;
    setQueuedMessage(null);
    sendComposerText(text, notify, idempotencyKey).catch(() => {
      showToast(`Couldn't send "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}" — try sending it again.`);
    });
  }, [online, queuedMessage, sendComposerText, showToast]);

  function selectChat(jobId: string) {
    setActiveJobId(jobId);
    setChatsOpen(false);
    router.push(`/roster/${encodeURIComponent(params.personaId)}?chat=${encodeURIComponent(jobId)}`, {
      scroll: false,
    });
  }

  function startNewChat() {
    setActiveJobId(null);
    setComposerText("");
    setSendError(null);
    setChatsOpen(false);
    router.push(`/roster/${encodeURIComponent(params.personaId)}?chat=new`, { scroll: false });
  }

  async function cancelActiveJob() {
    if (!activeJob || cancellingJob) return;
    setCancellingJob(true);
    setSendError(null);
    try {
      const updated = await client.cancelJob(activeJob.id);
      setActiveJob(updated);
      setJobs((prev) => prev.map((job) => (job.id === updated.id ? updated : job)));
    } catch (err) {
      setSendError(
        err instanceof ApiError ? (err.detail ?? `Couldn't cancel that (${err.status}).`) : "Couldn't cancel that.",
      );
    } finally {
      setCancellingJob(false);
    }
  }

  /** Redoes the chat's last turn from the last model turn -- only offered
   *  when the backend judges it safe (Job.retryEligible). Mirrors
   *  cancelActiveJob's error-handling shape. */
  async function retryActiveJob() {
    if (!activeJob || retryingJob) return;
    setRetryingJob(true);
    setSendError(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const updated = await client.retryJob(activeJob.id, idempotencyKey);
      setActiveJob(updated);
      setJobs((prev) => prev.map((job) => (job.id === updated.id ? updated : job)));
      loadTimeline(updated.id);
    } catch (err) {
      setSendError(
        err instanceof ApiError ? (err.detail ?? `Couldn't retry that (${err.status}).`) : "Couldn't retry that.",
      );
    } finally {
      setRetryingJob(false);
    }
  }

  if (state === "loading") {
    return (
      <main className={PAGE_PAD}>
        <p className="font-sans text-sm text-fg-muted">Loading…</p>
      </main>
    );
  }

  if (state === "not_found") {
    return (
      <main className={PAGE_PAD}>
        <EmptyState title="No such persona" description="They may have been dismissed." />
      </main>
    );
  }

  if (state === "error" || !persona) {
    return (
      <main className={PAGE_PAD}>
        <ErrorState detail="Couldn't load this persona." onRetry={load} />
      </main>
    );
  }

  const liveStatus = derivePersonaStatus(jobs, persona.id);
  const { disabled: composerDisabled, hint: composerHint } = composerState({
    online,
    sending,
    personaName: persona.name,
    activeJobStatus: activeJob?.status,
  });

  return (
    <main className={PERSONA_CHAT_LAYOUT.page} style={keyboardAwarePageStyle(keyboardInset)}>
      {/* Header — on a phone this is identity + overlay triggers, not a second pair of rails. */}
      <div className={PERSONA_CHAT_LAYOUT.header} style={{ borderColor: "var(--border)" }}>
        <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="md" />
        <div className="min-w-0 flex-1">
          <p className="m-0 mb-1 hidden font-mono text-[11px] uppercase tracking-wider text-fg-faint sm:block">
            <Link href="/roster" style={{ color: "var(--fg-faint)" }}>
              Roster
            </Link>{" "}
            &nbsp;/&nbsp; {persona.name}
          </p>
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 truncate font-serif text-[22px] text-fg sm:text-[26px]">{persona.name}</h1>
            <PersonaStatusBadge status={liveStatus} />
          </div>
          <p className="m-0 mt-1 hidden font-sans text-sm text-fg-muted sm:block">
            {persona.role} &middot;{" "}
            <span className="text-fg-faint">{displayModelName(persona.modelProvider, persona.modelName)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setChatsOpen((open) => !open)}
          className={PERSONA_CHAT_LAYOUT.mobileHeaderAction}
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
          aria-expanded={chatsOpen}
        >
          Chats
        </button>
        <Link
          href={`/roster/${persona.id}/manage`}
          className={`${SECONDARY_BUTTON} flex-none`}
          style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
        >
          Manage
        </Link>
      </div>

      {/* Body */}
      <div className={PERSONA_CHAT_LAYOUT.body}>
        {/* Chats sidebar -- desktop only; below md the same list renders
            inside the Sheet opened from the header's "Chats" action. */}
        <div
          className={PERSONA_CHAT_LAYOUT.chatSidebar}
          style={{ background: "var(--surface-sunken)", borderColor: "var(--border)" }}
        >
          <ChatsListBody
            jobs={sortedJobs}
            activeJobId={activeJobId}
            onSelect={selectChat}
            onNew={startNewChat}
            showEyebrow
          />
        </div>

        {/* Chat column */}
        <div className={PERSONA_CHAT_LAYOUT.chatColumn}>
          <div ref={transcriptRef} onScroll={handleTranscriptScroll} className={PERSONA_CHAT_LAYOUT.transcript}>
            {!activeJob && <p className="m-0 font-sans text-sm text-fg-muted">What should {persona.name} do?</p>}
            {activeJob && (
              <div className="flex min-w-0 max-w-full flex-col gap-5">
                {timeline.length === 0 && (
                  <p className="m-0 font-sans text-sm text-fg-muted">
                    {activeJob.prompt ?? "This chat predates message history — nothing to replay here."}
                  </p>
                )}
                {groupTimelineForPills(timeline).map((entry) =>
                  entry.kind === "activity_pill" ? (
                    <ActivityPillRow key={entry.key} pill={entry} />
                  ) : entry.kind === "delegation" ? (
                    <DelegationCard
                      key={`delegation-${entry.job.id}`}
                      job={entry.job}
                      persona={allPersonas.find((candidate) => candidate.id === entry.job.personaId)}
                    />
                  ) : entry.kind === "tool_call" ? (
                    <TranscriptRow
                      key={entry.toolCall.id}
                      // unframed like the rest of the transcript,
                      // except a failed call keeps its danger frame -- the
                      // one named exception to "approval card is the only
                      // bordered element" ("Failures never collapse and
                      // keep the danger frame").
                      framed={entry.toolCall.status === "failed"}
                      entry={toolCallTranscriptEntry(entry.toolCall)}
                    />
                  ) : entry.message.role === "user" ? (
                    <div key={entry.message.id} className="flex min-w-0 max-w-full justify-end">
                      <div className="flex min-w-0 max-w-[90%] flex-col items-end gap-1 sm:max-w-[62%]">
                        <div
                          className="max-w-full break-words rounded-button border px-4 py-3 font-sans text-[15px] leading-relaxed text-fg"
                          style={{ borderColor: "var(--accent-soft-border)", background: "var(--accent-soft)" }}
                        >
                          {entry.message.content}
                        </div>
                        <span className="font-mono text-[11px] text-fg-faint">
                          {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div key={entry.message.id} className="flex min-w-0 max-w-full gap-3 sm:max-w-[72%]">
                      <PersonaAvatar
                        id={persona.id}
                        name={persona.name}
                        role={persona.role}
                        size="sm"
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="mb-1 flex items-baseline gap-2">
                          <span className="font-sans text-[13px] font-medium text-fg-muted">{persona.name}</span>
                          <span className="font-mono text-[11px] text-fg-faint">
                            {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </span>
                        </div>
                        <MarkdownContent content={entry.message.content} />
                      </div>
                    </div>
                  ),
                )}

                {activeJob.status === "failed" && (
                  <div className="flex flex-col items-start gap-2">
                    <p
                      className="m-0 rounded-button border px-4 py-3 font-mono text-[13px] leading-relaxed"
                      style={{ borderColor: "var(--danger)", background: "var(--danger-soft)", color: "var(--danger)" }}
                    >
                      {activeJob.error ??
                        "This chat failed, but no error was recorded — it predates that being captured."}
                    </p>
                    <button
                      type="button"
                      disabled={!activeJob.retryEligible || retryingJob}
                      title={activeJob.retryEligible ? undefined : activeJob.retryBlockedReason}
                      onClick={retryActiveJob}
                      className="rounded-button border px-3 py-2 font-sans text-[13px] disabled:opacity-50"
                      style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                    >
                      {retryingJob ? "Retrying…" : "Retry"}
                    </button>
                  </div>
                )}

                {(activeJob.status === "queued" ||
                  activeJob.status === "running" ||
                  activeJob.status === "cancelling") && (
                  <div className="flex min-w-0 max-w-full flex-col gap-3 sm:pl-11">
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-badge px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-wider"
                        style={{ color: "var(--running-soft-fg)", background: "var(--running-soft)" }}
                      >
                        <i
                          className="status-dot-running"
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: "var(--running)",
                            display: "inline-block",
                          }}
                        />
                        {activeJob.status === "queued"
                          ? "Queued"
                          : activeJob.status === "cancelling"
                            ? "Cancelling"
                            : "Working"}
                      </span>
                      {(activeJob.status === "queued" || activeJob.status === "running") && (
                        <button
                          type="button"
                          disabled={cancellingJob}
                          onClick={cancelActiveJob}
                          className="rounded-button border px-2.5 py-1 font-sans text-xs disabled:opacity-50"
                          style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                        >
                          {cancellingJob ? "Cancelling…" : "Cancel"}
                        </button>
                      )}
                    </div>
                    <div className="flex min-w-0 max-w-full flex-col gap-3">
                      {liveTranscript
                        .filter((e) => e.kind === "tool_call" || e.kind === "tool_result")
                        .map((entry) => (
                          <TranscriptRow key={entry.key} entry={entry} framed={false} />
                        ))}
                    </div>
                  </div>
                )}

                {(activeJob.status === "cancelled" ||
                  activeJob.status === "timed_out" ||
                  activeJob.status === "outcome_unknown") && (
                  <div className="flex flex-col items-start gap-2">
                    <p
                      className="m-0 rounded-button border px-4 py-3 font-mono text-[13px] leading-relaxed"
                      style={{ borderColor: "var(--danger)", background: "var(--danger-soft)", color: "var(--danger)" }}
                    >
                      {activeJob.error ?? "This chat stopped before its outcome could be confirmed."}
                    </p>
                    <button
                      type="button"
                      disabled={!activeJob.retryEligible || retryingJob}
                      title={activeJob.retryEligible ? undefined : activeJob.retryBlockedReason}
                      onClick={retryActiveJob}
                      className="rounded-button border px-3 py-2 font-sans text-[13px] disabled:opacity-50"
                      style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                    >
                      {retryingJob ? "Retrying…" : "Retry"}
                    </button>
                  </div>
                )}

                {pendingApprovals.map((tc) => (
                  <ApprovalItem
                    key={tc.id}
                    client={client}
                    toolCall={tc}
                    persona={persona}
                    onResolved={() => {
                      if (activeJobId) client.getJob(activeJobId).then(setActiveJob);
                    }}
                  />
                ))}

                {activeJob.status === "waiting_approval" && (
                  <button
                    type="button"
                    disabled={cancellingJob}
                    onClick={cancelActiveJob}
                    className="self-start rounded-button border px-3 py-2 font-sans text-[13px] disabled:opacity-50"
                    style={{ borderColor: "var(--border-strong)", color: "var(--fg-muted)" }}
                  >
                    {cancellingJob ? "Cancelling chat…" : "Cancel entire chat"}
                  </button>
                )}

                <Link
                  href={`/logs/${activeJob.id}`}
                  className="self-start font-mono text-[11px] uppercase tracking-wider"
                  style={{ color: "var(--fg-faint)" }}
                >
                  View full audit log →
                </Link>
              </div>
            )}
          </div>

          {/* Composer */}
          <form
            onSubmit={submit}
            className={PERSONA_CHAT_LAYOUT.composer}
            style={{ background: "var(--surface-sunken)", borderColor: "var(--border)" }}
          >
            <div className="flex min-w-0 items-end gap-3">
              <textarea
                name="message"
                autoComplete="off"
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (!shouldSubmitChatComposer(e)) return;
                  e.preventDefault();
                  submit(e);
                }}
                disabled={composerDisabled}
                placeholder={`Message ${persona.name}…`}
                rows={1}
                className="min-w-0 flex-1 resize-none rounded-button border px-4 py-3 font-sans text-[15px] outline-none disabled:opacity-60"
                style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
              />
              <button
                type="submit"
                disabled={composerDisabled || !composerText.trim()}
                className={`grid ${TOUCH_TARGET} flex-none place-items-center rounded-button border-0 disabled:opacity-50`}
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
                aria-label="Send"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
            <NotificationIntentControl
              checked={notifyOnOutcome}
              onChange={setNotifyOnOutcome}
              deviceCount={pushDeviceCount}
            />
            {composerHint && <p className="m-0 mt-2 font-sans text-xs text-fg-muted">{composerHint}</p>}
            {sendError && (
              <p className="m-0 mt-2 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
                {sendError}
              </p>
            )}
          </form>
        </div>
      </div>

      {/* Chats -- desktop's is the inline column above; below md it's this
          Sheet instead, opened from the header's "Chats" action. */}
      <Sheet open={chatsOpen} onClose={() => setChatsOpen(false)} title="Chats" anchor="right">
        <ChatsListBody
          jobs={sortedJobs}
          activeJobId={activeJobId}
          onSelect={selectChat}
          onNew={startNewChat}
          showEyebrow={false}
        />
      </Sheet>
    </main>
  );
}

export default function PersonaDetailPage() {
  return (
    <Suspense
      fallback={
        <main className={PAGE_PAD}>
          <p className="font-sans text-sm text-fg-muted">Loading…</p>
        </main>
      }
    >
      <PersonaDetailContent />
    </Suspense>
  );
}
