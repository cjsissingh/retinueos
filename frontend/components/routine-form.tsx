"use client";

import { useState } from "react";
import { ApiClient, ApiError, type Routine } from "@/lib/api-client";
import { Toggle } from "@/components/ui/toggle";

const inputClass =
  "min-h-11 w-full rounded-button border px-3 py-2 font-sans text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const inputStyle = { borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" };

/** A routine is a named, scheduled job — not "run this persona". A persona
 *  can have several: a Morning Digest, an Inbox Sweep, a Fitness Check, each
 *  its own cadence and its own prompt. */
type RoutineFormProps = {
  client: ApiClient;
  personaId: string;
  onCancel?: () => void;
} & (
  | { routine?: never; onCreated: (routine: Routine) => void; onUpdated?: never }
  | { routine: Routine; onCreated?: never; onUpdated: (routine: Routine) => void }
);

export function RoutineForm(props: RoutineFormProps) {
  const { client, personaId, routine, onCancel } = props;
  const editing = routine !== undefined;
  const [name, setName] = useState(routine?.name ?? "");
  const [cronSchedule, setCronSchedule] = useState(routine?.cronSchedule ?? "");
  const [promptTemplate, setPromptTemplate] = useState(routine?.promptTemplate ?? "");
  const [notifyRoutineRan, setNotifyRoutineRan] = useState(routine?.notifyRoutineRan ?? false);
  const [kind, setKind] = useState<"job" | "digest">(routine?.kind ?? "job");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        name,
        cronSchedule,
        promptTemplate,
        notifyRoutineRan,
        kind,
      };
      if (routine) {
        props.onUpdated(await client.updateRoutine(routine.id, input));
        onCancel?.();
      } else {
        props.onCreated(await client.createRoutine(personaId, input));
        setName("");
        setCronSchedule("");
        setPromptTemplate("");
        setNotifyRoutineRan(false);
        setKind("job");
      }
    } catch (err) {
      const action = editing ? "save changes to" : "add";
      setError(
        err instanceof ApiError
          ? `Couldn't ${action} that routine (${err.status}).`
          : `Couldn't ${action} that routine.`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="m-0 font-serif text-lg text-fg">{editing ? "Edit routine" : "New routine"}</h3>
      <label className="flex flex-col gap-1.5 font-sans text-[13px] font-medium text-fg">
        Routine name
        <input
          name="name"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Morning digest"
          required
          className={inputClass}
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1.5 font-sans text-[13px] font-medium text-fg">
        Schedule
        <input
          name="cronSchedule"
          autoComplete="off"
          spellCheck={false}
          value={cronSchedule}
          onChange={(e) => setCronSchedule(e.target.value)}
          placeholder="e.g. 0 8 * * *"
          required
          className={`${inputClass} font-mono`}
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1.5 font-sans text-[13px] font-medium text-fg">
        Routine type
        <select
          name="kind"
          value={kind}
          // SAFETY: value is constrained to the <option>s below, which only emit "job" or "digest".
          onChange={(e) => setKind(e.target.value as "job" | "digest")}
          className={inputClass}
          style={inputStyle}
        >
          <option value="job">Job — run a chat turn each time this fires</option>
          <option value="digest">Digest — scan state/recent jobs and report back, no chat turn</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5 font-sans text-[13px] font-medium text-fg">
        Instructions
        <textarea
          name="instructions"
          autoComplete="off"
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          placeholder={
            kind === "digest"
              ? "Ignored for a digest routine — digests are generated automatically."
              : "What should they do each time this fires?"
          }
          required
          rows={3}
          className={inputClass}
          style={inputStyle}
        />
      </label>
      <div className="flex min-h-11 items-center gap-2 font-sans text-[13px] text-fg-muted">
        <Toggle checked={notifyRoutineRan} onChange={setNotifyRoutineRan} label="Notify when this routine runs" />
        Notify when this routine runs
      </div>
      {error && (
        <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="min-h-11 rounded-button border-0 px-3.5 py-2 font-sans text-[13px] font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
        >
          {submitting ? (editing ? "Saving…" : "Adding…") : editing ? "Save changes" : "Add routine"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-button border px-3.5 py-2 font-sans text-[13px]"
            style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg-muted)" }}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
