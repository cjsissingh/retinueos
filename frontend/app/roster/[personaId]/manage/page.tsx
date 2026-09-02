import { Suspense } from "react";
import { PersonaManagement } from "@/components/persona-management";
import { PAGE_PAD } from "@/lib/touch-layout";

export default function PersonaManagementPage() {
  return (
    <Suspense
      fallback={
        <main className={PAGE_PAD}>
          <p className="font-sans text-sm text-fg-muted">Loading workspace…</p>
        </main>
      }
    >
      <PersonaManagement />
    </Suspense>
  );
}
