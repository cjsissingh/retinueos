/**
 * whether AppShell may paint the authenticated chrome (sidebar /
 * bottom nav) for the current render. Kept as a pure function -- rather
 * than inline in app-shell.tsx's render -- so the "never show chrome
 * before we've confirmed a stored password" invariant is unit-testable;
 * this repo's Vitest setup has no next/navigation harness to mount
 * AppShell itself.
 *
 * `authChecked` / `authed` come from a client-only effect (localStorage
 * isn't readable during SSR), so both start false and must stay false --
 * not "assume authed" -- until that effect settles: the whole point is
 * that a signed-out launch of an app route never paints chrome, even for
 * one frame, while its own page effect redirects to /login.
 */
export function shouldRenderChrome(params: { signedOut: boolean; authChecked: boolean; authed: boolean }): boolean {
  if (params.signedOut) return false;
  return params.authChecked && params.authed;
}
