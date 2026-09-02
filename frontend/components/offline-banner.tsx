import { offlineBannerText } from "@/lib/last-synced";

/**
 * Design guide §05: "thin amber strip under the header" -- sits
 * inside AppShell's <main>, above every page's own content, so it's the
 * same one strip regardless of which route is open. Takes `online` /
 * `lastSyncedAt` as props (rather than reading useOnlineStatus itself) so
 * it stays a plain presentational component, renderable with
 * renderToStaticMarkup in tests without a browser-events harness.
 */
export function OfflineBanner({ online, lastSyncedAt }: { online: boolean; lastSyncedAt: number | null }) {
  if (online) return null;
  return (
    <div role="status" className="bg-warning-soft px-4 py-1.5 text-center font-sans text-xs text-warning-soft-fg">
      {offlineBannerText(lastSyncedAt)}
    </div>
  );
}
