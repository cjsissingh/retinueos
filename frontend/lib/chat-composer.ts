/** Keyboard contract for the persona chat composer. */

export type ChatComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

/**
 * Return submits. Shift+Return inserts a newline (the textarea default).
 * IME composition Enter must not submit — it confirms the candidate.
 */
export function shouldSubmitChatComposer(event: ChatComposerKeyEvent): boolean {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  return event.key === "Enter" && !event.shiftKey;
}
