"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClient, type Job, type Persona, type PersonaGeneratedDraft, type PersonaTemplate } from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { PersonaCard } from "@/components/persona-card";
import { AddEmployeeForm } from "@/components/add-employee-form";
import { PersonaTemplatePicker } from "@/components/persona-template-picker";
import { PageHeader } from "@/components/page-header";
import { PersonaCardSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { derivePersonaStatus } from "@/components/status-badge";
import { OrgChart } from "@/components/org-chart";
import { PAGE_PAD, PRIMARY_BUTTON } from "@/lib/touch-layout";
import { usePendingApprovals } from "@/lib/use-pending-approvals";

type LoadState = "loading" | "ready" | "error";
type View = "cards" | "org_chart";

export default function RosterPage() {
  const router = useRouter();
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  // hiring is a compact three-step flow — closed, choose a starting
  // point, then the actual form. Choosing "Start from scratch" (a null
  // draft) skips straight to a blank form, same as before this ticket.
  const [hireStep, setHireStep] = useState<"closed" | "choose" | "form">("closed");
  const [templates, setTemplates] = useState<PersonaTemplate[] | null>(null);
  // A chosen starter template or an AI-generated draft —
  // both prefill the hire form the same way, so one slot covers either.
  const [chosenDraft, setChosenDraft] = useState<PersonaTemplate | PersonaGeneratedDraft | null>(null);
  const showForm = hireStep !== "closed";
  // Cards is the default; the org chart ("Structure") is a
  // deliberate switch-to, not the landing view.
  const [view, setView] = useState<View>("cards");
  const { revision } = usePendingApprovals();

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [p, j] = await Promise.all([client.listPersonas(), client.listJobs()]);
      setPersonas(p);
      setJobs(j);
      setState("ready");
    } catch (err) {
      if (handleUnauthorized(err, router)) return;
      setState("error");
    }
  }, [client, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  // An approval resolved (or created) elsewhere changes job status off
  // (or onto) waiting_approval. The workspace pending stream bumps
  // `revision` so this list can drop the "Needs you" card immediately.
  useEffect(() => {
    if (revision === 0 || !getStoredPassword()) return;
    client.listJobs().then(setJobs, () => {});
  }, [revision, client]);

  useEffect(() => {
    if (hireStep !== "choose" || templates !== null) return;
    client.listPersonaTemplates().then(setTemplates, () => setTemplates([]));
  }, [hireStep, templates, client]);

  function openHireFlow() {
    setHireStep("choose");
  }

  function closeHireFlow() {
    setHireStep("closed");
    setChosenDraft(null);
  }

  const working = personas.filter((p) => derivePersonaStatus(jobs, p.id) === "on_it").length;
  const needsYou = personas.filter((p) => derivePersonaStatus(jobs, p.id) === "needs_you").length;

  const eyebrow = [
    `${personas.length} on staff`,
    working > 0 ? `${working} working` : null,
    needsYou > 0 ? `${needsYou} needs you` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={state === "ready" ? eyebrow : "Roster"}
        title="Roster"
        actions={
          <>
            {state === "ready" && personas.length > 0 && (
              <div className="flex rounded-button border p-0.5" style={{ borderColor: "var(--border-strong)" }}>
                {(
                  [
                    { id: "cards", label: "Cards" },
                    { id: "org_chart", label: "Structure" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setView(opt.id)}
                    className="rounded-[5px] border-0 px-3 font-sans text-[13px] font-medium"
                    style={{
                      background: view === opt.id ? "var(--fg)" : "transparent",
                      color: view === opt.id ? "var(--bg)" : "var(--fg-muted)",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => (showForm ? closeHireFlow() : openHireFlow())}
              className={PRIMARY_BUTTON}
              style={{ background: "var(--fg)", color: "var(--bg)" }}
            >
              {showForm ? "Close" : "Hire a persona"}
            </button>
          </>
        }
      />

      {hireStep === "choose" && (
        <div className="mb-6">
          <PersonaTemplatePicker
            client={client}
            templates={templates ?? []}
            loading={templates === null}
            onChoose={(draft) => {
              setChosenDraft(draft);
              setHireStep("form");
            }}
          />
        </div>
      )}

      {hireStep === "form" && (
        <div className="mb-6">
          <AddEmployeeForm
            client={client}
            personas={personas}
            draft={
              chosenDraft
                ? {
                    name: chosenDraft.name,
                    role: chosenDraft.role,
                    systemPrompt: chosenDraft.systemPrompt,
                    scopeDescription: chosenDraft.scopeDescription,
                    voiceNotes: chosenDraft.voiceNotes,
                    boundaries: chosenDraft.boundaries,
                    assignedToolIds: chosenDraft.defaultTools,
                  }
                : undefined
            }
            onCreated={(p) => {
              setPersonas((prev) => [...prev, p]);
              closeHireFlow();
            }}
            onCancel={closeHireFlow}
          />
        </div>
      )}

      {state === "error" && <ErrorState detail="GET /personas failed. Nothing has been lost." onRetry={load} />}

      {state === "loading" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <PersonaCardSkeleton key={i} />
          ))}
        </div>
      )}

      {state === "ready" && personas.length === 0 && (
        <EmptyState
          title="Nobody on staff yet"
          description="Hire your first persona and give them something to do."
          action={
            <button
              type="button"
              onClick={openHireFlow}
              className={PRIMARY_BUTTON}
              style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
            >
              Hire a persona
            </button>
          }
        />
      )}

      {state === "ready" && personas.length > 0 && view === "cards" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {personas.map((p) => (
            <PersonaCard key={p.id} persona={p} status={derivePersonaStatus(jobs, p.id)} />
          ))}
        </div>
      )}

      {state === "ready" && personas.length > 0 && view === "org_chart" && <OrgChart personas={personas} jobs={jobs} />}
    </main>
  );
}
