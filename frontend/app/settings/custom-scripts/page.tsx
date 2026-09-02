import { Suspense } from "react";
import { CustomScriptsContent } from "./custom-scripts-content";

export default function CustomScriptsSettingsPage() {
  return (
    <Suspense fallback={<div className="p-8 font-sans text-sm text-fg-muted">Loading…</div>}>
      <CustomScriptsContent />
    </Suspense>
  );
}
