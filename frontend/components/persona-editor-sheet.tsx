"use client";

import type { ReactNode } from "react";
import { PersonaForm } from "@/components/persona-form";
import { Sheet } from "@/components/ui/sheet";
import type { ApiClient, Persona } from "@/lib/api-client";

export function PersonaEditorSheet({
  open,
  onClose,
  client,
  persona,
  managerCandidates,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  client: ApiClient;
  persona: Persona;
  managerCandidates: Persona[];
  onSaved: (persona: Persona) => void;
}): ReactNode {
  return (
    <Sheet open={open} onClose={onClose} title="Edit persona" anchor="right">
      <PersonaForm
        client={client}
        managerCandidates={managerCandidates}
        initial={persona}
        presentation="sheet"
        onSave={(input) => client.updatePersona(persona.id, input)}
        onSaved={onSaved}
        onCancel={onClose}
        title="Edit persona"
        submitLabel="Save changes"
        submittingLabel="Saving…"
        saveErrorLabel="save changes"
      />
    </Sheet>
  );
}
