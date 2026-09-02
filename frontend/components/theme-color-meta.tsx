/**
 * installed-PWA chrome (iOS status bar, Android task switcher) reads
 * `<meta name="theme-color">`, and needs the light/dark brass and near-black
 * values respectively. Next.js's `viewport.themeColor` only ever emits one
 * fixed tag, so this pair -- gated on `prefers-color-scheme` instead of the
 * app's own theme state, since the browser chrome painting this has no
 * access to that -- replaces it. Split out from app/layout.tsx so it can be
 * unit tested without pulling in AppShell's router-context hooks.
 */
export function ThemeColorMeta() {
  return (
    <>
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="#8a6a2f" />
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#14130f" />
    </>
  );
}
