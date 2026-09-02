import { Suspense } from "react";
import { LogsContent } from "./logs-content";

export default function LogsPage() {
  return (
    <Suspense fallback={<div className="p-8 font-sans text-sm text-fg-muted">Loading…</div>}>
      <LogsContent />
    </Suspense>
  );
}
