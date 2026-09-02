import { Suspense } from "react";
import { AuditContent } from "./audit-content";

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="p-8 font-sans text-sm text-fg-muted">Loading…</div>}>
      <AuditContent />
    </Suspense>
  );
}
