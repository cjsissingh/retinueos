import { Suspense } from "react";
import { McpSettingsContent } from "./mcp-settings-content";

export default function McpSettingsPage() {
  return (
    <Suspense fallback={<div className="p-8 font-sans text-sm text-fg-muted">Loading…</div>}>
      <McpSettingsContent />
    </Suspense>
  );
}
