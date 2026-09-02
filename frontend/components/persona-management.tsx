"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ApiClient,
  ApiError,
  type Memory,
  type ModelCall,
  type Persona,
  type PersonaStateEntry,
  type Routine,
} from "@/lib/api-client";
import { getStoredPassword, handleUnauthorized } from "@/lib/auth";
import { displayModelName } from "@/lib/display";
import { PAGE_PAD, SECONDARY_BUTTON } from "@/lib/touch-layout";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { PersonaAvatar } from "@/components/persona-avatar";
import { PersonaIdentityForm } from "@/components/persona-identity-form";
import { PersonaCharterForm } from "@/components/persona-charter-form";
import { PersonaToolsSection } from "@/components/persona-tools-section";
import { PersonaTeamSection } from "@/components/persona-team-section";
import { PersonaSidePanel } from "@/components/persona-side-panel";
import {
  isPersonaWorkspaceSection,
  PersonaWorkspaceNav,
  type PersonaWorkspaceSection,
} from "@/components/persona-workspace-nav";

type LoadState = "loading" | "ready" | "error" | "not_found";

const SECTION_DESCRIPTION = {
  identity: "Name, role, voice, and which model this person runs on.",
  charter: "Core instructions, scope, and the boundaries that shape how this person works.",
  routines: "Recurring work this person runs without being asked each time.",
  tools: "The capabilities available to this person and the approval level for each.",
  team: "Where this person sits in the reporting structure.",
  memory: "Durable facts this person can recall, and the named loop notes they keep between jobs.",
  telemetry: "Recent model activity, token volume, latency, and errors.",
} satisfies Record<PersonaWorkspaceSection, string>;

export function PersonaManagement() {
  const params = useParams<{ personaId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSection = searchParams.get("section");
  const section: PersonaWorkspaceSection = isPersonaWorkspaceSection(requestedSection) ? requestedSection : "identity";
  const [client] = useState(
    () => new ApiClient(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080", getStoredPassword),
  );
  const [state, setState] = useState<LoadState>("loading");
  const [persona, setPersona] = useState<Persona | null>(null);
  const [allPersonas, setAllPersonas] = useState<Persona[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loopState, setLoopState] = useState<PersonaStateEntry[]>([]);
  const [modelCalls, setModelCalls] = useState<ModelCall[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [person, people, scheduledWork, rememberedFacts, namedNotes, calls] = await Promise.all([
        client.getPersona(params.personaId),
        client.listPersonas(),
        client.listRoutines(params.personaId),
        client.listMemories(params.personaId).catch(() => []),
        client.listPersonaState(params.personaId).catch(() => []),
        client.listModelCalls(params.personaId),
      ]);
      setPersona(person);
      setAllPersonas(people);
      setRoutines(scheduledWork);
      setMemories(rememberedFacts);
      setLoopState(namedNotes);
      setModelCalls(calls);
      setState("ready");
    } catch (error) {
      if (handleUnauthorized(error, router)) return;
      setState(error instanceof ApiError && error.status === 404 ? "not_found" : "error");
    }
  }, [client, params.personaId, router]);

  useEffect(() => {
    if (!getStoredPassword()) {
      router.push("/login");
      return;
    }
    load();
  }, [load, router]);

  // Applies a save from any section's form to both the focused persona and
  // its entry in the roster-wide list -- managerCandidates/directReports
  // below and the nav's Team count all read from allPersonas, so a Team
  // section edit (which changes another persona's implicit "reports to" set
  // only via this persona's own row) has to land in both places at once.
  const applyUpdate = useCallback((updated: Persona) => {
    setPersona(updated);
    setAllPersonas((people) => people.map((person) => (person.id === updated.id ? updated : person)));
  }, []);

  const managerCandidates = useMemo(() => {
    if (!persona) return [];
    const descendantIds = new Set<string>();
    function collectDescendants(id: string) {
      for (const candidate of allPersonas) {
        if (candidate.reportsTo === id && !descendantIds.has(candidate.id)) {
          descendantIds.add(candidate.id);
          collectDescendants(candidate.id);
        }
      }
    }
    collectDescendants(persona.id);
    return allPersonas.filter((candidate) => candidate.id !== persona.id && !descendantIds.has(candidate.id));
  }, [allPersonas, persona]);

  const directReports = useMemo(
    () => (persona ? allPersonas.filter((p) => p.reportsTo === persona.id) : []),
    [allPersonas, persona],
  );

  if (state === "loading") {
    return (
      <main className={PAGE_PAD}>
        <p className="font-sans text-sm text-fg-muted">Loading workspace…</p>
      </main>
    );
  }

  if (state === "not_found") {
    return (
      <main className={PAGE_PAD}>
        <PageHeader eyebrow="Roster" title="Person not found" backHref="/roster" />
      </main>
    );
  }

  if (state === "error" || !persona) {
    return (
      <main className={PAGE_PAD}>
        <PageHeader eyebrow="Roster" title="Couldn’t load workspace" backHref="/roster" />
        <ErrorState detail="Nothing has been changed." onRetry={load} />
      </main>
    );
  }

  return (
    <main className={PAGE_PAD}>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <PersonaAvatar id={persona.id} name={persona.name} role={persona.role} size="sm" />
            Manage person
          </span>
        }
        title={persona.name}
        description={`${persona.role} · ${displayModelName(persona.modelProvider, persona.modelName)}`}
        backHref="/roster"
        actions={
          <Link
            href={`/roster/${persona.id}`}
            className={SECONDARY_BUTTON}
            style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--fg)" }}
          >
            Back to chat
          </Link>
        }
      />

      <div className="flex min-w-0 flex-col gap-6 border-t pt-6 md:flex-row md:gap-8">
        <PersonaWorkspaceNav
          personaId={persona.id}
          active={section}
          counts={{
            tools: persona.assignedToolIds.length,
            team: directReports.length,
            routines: routines.length,
            memory: memories.length + loopState.length,
          }}
        />
        <section className="min-w-0 max-w-[780px] flex-1" aria-labelledby="workspace-section-title">
          <div className="mb-6 border-b pb-5">
            <p className="m-0 font-mono text-[11px] uppercase tracking-wider text-fg-faint">{persona.name}</p>
            <h2 id="workspace-section-title" className="m-0 mt-1 font-serif text-2xl text-fg">
              {section === "telemetry" ? "Usage" : section.charAt(0).toUpperCase() + section.slice(1)}
            </h2>
            <p className="m-0 mt-2 font-sans text-sm leading-relaxed text-fg-muted">{SECTION_DESCRIPTION[section]}</p>
          </div>

          {section === "identity" && <PersonaIdentityForm client={client} persona={persona} onSaved={applyUpdate} />}
          {section === "charter" && <PersonaCharterForm client={client} persona={persona} onSaved={applyUpdate} />}
          {section === "tools" && <PersonaToolsSection client={client} persona={persona} onSaved={applyUpdate} />}
          {section === "team" && (
            <PersonaTeamSection
              client={client}
              persona={persona}
              managerCandidates={managerCandidates}
              directReports={directReports}
              onSaved={applyUpdate}
            />
          )}
          {(section === "routines" || section === "memory" || section === "telemetry") && (
            <PersonaSidePanel
              panel={section}
              onClose={() => router.push(`/roster/${persona.id}/manage`)}
              persona={persona}
              client={client}
              routines={routines}
              onRoutineCreated={(routine) => setRoutines((current) => [...current, routine])}
              onRoutineUpdated={(routine) =>
                setRoutines((current) => current.map((item) => (item.id === routine.id ? routine : item)))
              }
              memories={memories}
              onMemoryDeleted={(id) => setMemories((current) => current.filter((memory) => memory.id !== id))}
              loopState={loopState}
              onLoopStateDeleted={(key) => setLoopState((current) => current.filter((entry) => entry.key !== key))}
              modelCalls={modelCalls}
            />
          )}
        </section>
      </div>
    </main>
  );
}
