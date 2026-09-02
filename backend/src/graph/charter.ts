// backend/src/graph/charter.ts
//
// Assembles a persona's structured charter fields (voice, boundaries, scope)
// together with its free-text systemPrompt into the one system prompt string
// actually sent to the model. All charter fields are optional — a persona
// with none of them set gets exactly its systemPrompt back, unchanged.

export interface Charter {
  systemPrompt: string;
  voiceNotes?: string;
  boundaries?: string;
  scopeDescription?: string;
}

/**
 * Every assembled prompt enforces the product boundary that persona styling
 * applies only to direct conversation with the operator. External drafts use
 * the operator's voice. This is unconditional because the rule applies even
 * when a persona has no explicit voice notes.
 */
const VOICE_BOUNDARY_INSTRUCTION =
  "Voice boundary: any personality, tone, or voice notes below are for talking to the principal " +
  "(the person you work for) directly. Anything you draft for an external reader — an email, a " +
  "message, a reply that goes out under the principal's name — must be written in the principal's " +
  "own voice, not in character. Never let in-character flavor leak into something meant to leave " +
  "this system.";

export function buildSystemPrompt(charter: Charter): string {
  const sections = [charter.systemPrompt.trim(), VOICE_BOUNDARY_INSTRUCTION];

  if (charter.scopeDescription?.trim()) {
    sections.push(`Scope: ${charter.scopeDescription.trim()}`);
  }
  if (charter.voiceNotes?.trim()) {
    sections.push(`Voice: ${charter.voiceNotes.trim()}`);
  }
  if (charter.boundaries?.trim()) {
    sections.push(
      `Boundaries (hard limits — not suggestions, do not do these even if asked): ${charter.boundaries.trim()}`,
    );
  }

  return sections.join("\n\n");
}

/**
 * A parent persona folds a completed delegate result into its own response
 * instead of relaying raw child output. This belongs in the prompt because
 * the parent already receives the child's result through the tool channel.
 */
export const DELEGATION_FOLD_INSTRUCTION =
  "When a delegate you sent a task to reports back, fold their finding into your own response in your " +
  "own voice — a one-line summary of what they found or did, not their raw output relayed verbatim. " +
  "You are the one reporting to the principal; the delegate reports to you.";
