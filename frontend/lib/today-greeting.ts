/**
 * The Today screen's serif greeting + the one line of state beneath it
 * (design guide §01). Kept out of `app/today/page.tsx` so the copy
 * rules — no exclamation marks, subject-verb-object, a fixed empty-day
 * string — are testable without the page's client-component runtime (same
 * seam as `lib/chat-title.ts`).
 */

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function numberWord(n: number): string {
  return n <= 10 ? NUMBER_WORDS[n] : String(n);
}

/** Capitalized number word — every clause below opens a sentence. */
function leadingNumberWord(n: number): string {
  const word = numberWord(n);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Time-of-day greeting. `now` is injectable so this is testable without
 *  mocking the system clock. */
export function greetingWord(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export interface GreetingCounts {
  /** Pending tool calls the operator can act on right now. */
  needsYou: number;
  /** Distinct personas with a job in flight (queued/running/cancelling). */
  working: number;
  /** Jobs that reached a failure-shaped terminal status today. */
  failedToday: number;
  /** Total outcome rows in "Done today" — used only to detect the empty day. */
  doneToday: number;
}

/**
 * The design doc's worked example is "Three things need you. Two people are
 * working. Nothing failed overnight." — up to three short clauses, each
 * subject-verb-object about a count, never an exclamation mark. An empty
 * day (nothing needs you, nothing running, nothing done) replaces the whole
 * line with the specified copy rather than composing "Nothing needs you.
 * Nobody is working. Nothing failed overnight." — three negatives in a row
 * reads as broken, not calm.
 */
export function greetingStateLine(counts: GreetingCounts): string {
  const { needsYou, working, failedToday, doneToday } = counts;
  if (needsYou === 0 && working === 0 && doneToday === 0) return "Nobody's waiting on you.";

  const clauses: string[] = [];
  if (needsYou > 0) {
    clauses.push(needsYou === 1 ? "One thing needs you." : `${leadingNumberWord(needsYou)} things need you.`);
  }
  if (working > 0) {
    clauses.push(working === 1 ? "One person is working." : `${leadingNumberWord(working)} people are working.`);
  }
  clauses.push(
    failedToday === 0
      ? "Nothing failed overnight."
      : failedToday === 1
        ? "One thing failed overnight."
        : `${leadingNumberWord(failedToday)} things failed overnight.`,
  );
  return clauses.join(" ");
}
