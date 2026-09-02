/**
 * "Notify me when this finishes" remembers its last choice per
 * persona, so a chip left checked for a persona you routinely leave running
 * stays checked next time you open that chat -- rather than defaulting back
 * to off and relying on you to notice and recheck it. Scoped per persona
 * (not global, not per chat) because the composer's own copy is about
 * leaving *this persona* running unattended, and that's a habit that tracks
 * who you asked, not which specific chat.
 */
const STORAGE_KEY_PREFIX = "retinueos-notify-on-outcome:";

export function getStoredNotifyPreference(personaId: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY_PREFIX + personaId) === "1";
  } catch {
    // Private-mode / storage-blocked browsers: the chip just won't
    // remember -- no worse than the un-persisted behavior it replaces.
    return false;
  }
}

export function setStoredNotifyPreference(personaId: string, value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_PREFIX + personaId, value ? "1" : "0");
  } catch {
    // Same fallback as above -- nothing to recover, nothing to surface.
  }
}
