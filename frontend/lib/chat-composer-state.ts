import type { Job } from "./api-client.js";

export interface ComposerState {
  disabled: boolean;
  hint: string | null;
}

/**
 * what the chat composer should show, as a pure function of
 * connectivity and the active job's status -- extracted out of
 * app/roster/[personaId]/page.tsx's composerDisabled/composerHint so the
 * "offline wins over every other reason the composer might be disabled"
 * rule is unit-testable without that page's next/navigation harness.
 */
export function composerState(params: {
  online: boolean;
  sending: boolean;
  personaName: string;
  activeJobStatus: Job["status"] | undefined;
}): ComposerState {
  if (!params.online) {
    return { disabled: true, hint: "Offline — queued when you're back." };
  }
  const activeJobCanContinue =
    params.activeJobStatus === undefined || params.activeJobStatus === "done" || params.activeJobStatus === "failed";
  const disabled = params.sending || !activeJobCanContinue;
  const hint =
    params.activeJobStatus === "queued" || params.activeJobStatus === "running"
      ? `${params.personaName} is still working on the last message.`
      : params.activeJobStatus === "waiting_approval"
        ? `${params.personaName} is waiting on your approval below.`
        : params.activeJobStatus === "cancelling"
          ? "Cancellation requested — waiting for a safe final status."
          : params.activeJobStatus && !activeJobCanContinue
            ? "This chat is closed. Start a new chat to send another message."
            : null;
  return { disabled, hint };
}
