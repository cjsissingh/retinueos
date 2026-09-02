"use client";

import { ApiClient, type AssignedToolConfig, type Persona } from "@/lib/api-client";
import { PersonaForm } from "@/components/persona-form";

export function AddEmployeeForm({
  client,
  personas = [],
  draft,
  onCreated,
  onCancel,
}: {
  client: ApiClient;
  /** Existing personas, offered as candidate managers for "Reports to" — the
   *  org chart. Empty on the very first hire, which is fine: that persona
   *  simply has nobody to report to yet. */
  personas?: Persona[];
  /** Seed values from a chosen starter template. Omit for a blank hire. */
  draft?: {
    name?: string;
    role?: string;
    systemPrompt?: string;
    scopeDescription?: string;
    voiceNotes?: string;
    boundaries?: string;
    assignedToolIds?: AssignedToolConfig[];
  };
  onCreated: (persona: Persona) => void;
  onCancel?: () => void;
}) {
  return (
    <PersonaForm
      client={client}
      managerCandidates={personas}
      draft={draft}
      onSave={(input) => client.createPersona(input)}
      onSaved={onCreated}
      onCancel={onCancel}
      title="Hire a persona"
      submitLabel="Hire"
      submittingLabel="Hiring…"
      saveErrorLabel="hire them"
    />
  );
}
