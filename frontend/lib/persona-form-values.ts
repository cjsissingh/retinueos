import type { AssignedToolConfig } from "@/lib/api-client";

/** Everything a persona create/edit submission needs. Shape mirrors
 *  PersonaCreateInput exactly — both createPersona and updatePersona accept
 *  it (a PATCH is just a subset of the same fields), so callers can pass
 *  either straight through as `onSave`. */
export interface PersonaFormValues {
  name: string;
  role: string;
  systemPrompt: string;
  scopeDescription: string;
  voiceNotes: string;
  boundaries: string;
  modelProvider: string;
  modelName: string;
  assignedToolIds: AssignedToolConfig[];
  reportsTo: string | null;
}

export function buildPersonaFormValues({
  name,
  role,
  systemPrompt,
  scopeDescription,
  voiceNotes,
  boundaries,
  modelProvider,
  modelName,
  tools,
  reportsTo,
}: {
  name: string;
  role: string;
  systemPrompt: string;
  scopeDescription: string;
  voiceNotes: string;
  boundaries: string;
  modelProvider: string;
  modelName: string;
  tools: Record<string, AssignedToolConfig>;
  reportsTo: string;
}): PersonaFormValues {
  return {
    name,
    role,
    systemPrompt,
    scopeDescription,
    voiceNotes,
    boundaries,
    modelProvider,
    modelName,
    assignedToolIds: Object.values(tools),
    reportsTo: reportsTo || null,
  };
}
