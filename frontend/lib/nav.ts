/**
 * Shell navigation data. Split out of app-shell.tsx so the mobile
 * tab count -- the whole point of this ticket -- can be locked with a test
 * without mounting the shell (no jsdom in this repo's frontend tests; see
 * frontend/AGENTS.md).
 */

export interface NavItem {
  href: string;
  label: string;
  mobileLabel: string;
}

// Desktop (>= md) sidebar -- unchanged full list and order from // Today · Approvals · Chats · Roster · Logs, then the settings group.
export const PRIMARY_NAV: readonly NavItem[] = [
  { href: "/today", label: "Today", mobileLabel: "Today" },
  { href: "/approvals", label: "Approvals", mobileLabel: "Approvals" },
  { href: "/chats", label: "Chats", mobileLabel: "Chats" },
  { href: "/roster", label: "Roster", mobileLabel: "Roster" },
  { href: "/logs", label: "Logs", mobileLabel: "Logs" },
  { href: "/audit", label: "Audit", mobileLabel: "Audit" },
] as const;

export const SETTINGS_NAV: readonly NavItem[] = [
  { href: "/settings/mcp", label: "Connections", mobileLabel: "Connect" },
  { href: "/settings/custom-scripts", label: "Scripts", mobileLabel: "Scripts" },
  { href: "/settings/access", label: "Access", mobileLabel: "Access" },
  { href: "/settings/notifications", label: "Notifications", mobileLabel: "Alerts" },
] as const;

export const NAV: readonly NavItem[] = [...PRIMARY_NAV, ...SETTINGS_NAV];

export type MobileTab =
  { kind: "link"; href: string; label: string; mobileLabel: string } | { kind: "more"; label: string };

// Mobile (< md) bottom bar -- exactly five destinations. The old bar put
// all ten NAV items plus Ask in one row (10px labels on a 390px screen);
// this is the fix. The fifth tab isn't a route -- it opens the More
// sheet (MORE_NAV below) instead of navigating.
export const MOBILE_TABS: readonly MobileTab[] = [
  { kind: "link", href: "/today", label: "Today", mobileLabel: "Today" },
  { kind: "link", href: "/approvals", label: "Approvals", mobileLabel: "Approvals" },
  { kind: "link", href: "/chats", label: "Chats", mobileLabel: "Chats" },
  { kind: "link", href: "/roster", label: "Roster", mobileLabel: "Roster" },
  { kind: "more", label: "More" },
] as const;

// Contents of the More sheet -- everything the old flat mobile bar used to
// cram in past the fifth slot. Theme and Sign out are appended separately
// in app-shell.tsx (neither is a route).
export const MORE_NAV: readonly NavItem[] = [
  { href: "/settings/mcp", label: "Connections", mobileLabel: "Connections" },
  { href: "/settings/custom-scripts", label: "Scripts", mobileLabel: "Scripts" },
  { href: "/settings/access", label: "Access", mobileLabel: "Access" },
  { href: "/audit", label: "Audit", mobileLabel: "Audit" },
  { href: "/logs", label: "Logs", mobileLabel: "Logs" },
  { href: "/settings/notifications", label: "Notification settings", mobileLabel: "Notifications" },
] as const;
