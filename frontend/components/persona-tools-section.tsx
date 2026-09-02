"use client";

import { useEffect, useRef, useState } from "react";
import { ApiClient, ApiError, type AssignedToolConfig, type AvailableMcpTool, type Persona } from "@/lib/api-client";
import { ToolPermissionsEditor } from "@/components/tool-permissions";
import { personaToolOptions } from "@/components/persona-form";

/**
 * Tools section of the persona workspace — design guide calls
 * permission changes a row-level action, same as Pause/Run now/Forget: they
 * save immediately, never waiting on a form Save button. `persist` below
 * serializes writes (a queued `next` replaces any still-pending one rather
 * than firing overlapping PATCHes) and, on success, adopts the *server's*
 * `assignedToolIds` rather than the optimistic value -- a destructive tool
 * set to Allow is coerced to Ask on write (tools/autonomy.ts), and the
 * editor needs to reflect that, not the pre-coercion click. On failure the
 * optimistic change is rolled back and an error shown, so a permission edit
 * that didn't actually persist never look saved.
 */
export function PersonaToolsSection({
  client,
  persona,
  onSaved,
}: {
  client: ApiClient;
  persona: Persona;
  onSaved: (persona: Persona) => void;
}) {
  const [tools, setTools] = useState<Record<string, AssignedToolConfig>>(() =>
    Object.fromEntries(persona.assignedToolIds.map((t) => [t.toolId, t])),
  );
  const [toolQuery, setToolQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef<Record<string, AssignedToolConfig> | null>(null);

  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  // null = "haven't heard back yet" -- see personaToolOptions' doc comment.
  const [mcpToolOptions, setMcpToolOptions] = useState<AvailableMcpTool[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.getConfig().then(
      ({ webSearchAvailable: searchAvailable }) => {
        if (!cancelled) setWebSearchAvailable(searchAvailable);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    client.listAvailableMcpTools().then(
      (options) => {
        if (!cancelled) setMcpToolOptions(options);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function persist(next: Record<string, AssignedToolConfig>) {
    if (savingRef.current) {
      pendingRef.current = next;
      return;
    }
    savingRef.current = true;
    setError(null);
    const previous = tools;
    setTools(next);
    try {
      const updated = await client.updatePersona(persona.id, { assignedToolIds: Object.values(next) });
      setTools(Object.fromEntries(updated.assignedToolIds.map((t) => [t.toolId, t])));
      onSaved(updated);
    } catch (err) {
      setTools(previous);
      setError(err instanceof ApiError ? `Couldn't save that change (${err.status}).` : "Couldn't save that change.");
    } finally {
      savingRef.current = false;
      const queued = pendingRef.current;
      if (queued) {
        pendingRef.current = null;
        persist(queued);
      }
    }
  }

  const toolOptions = personaToolOptions(mcpToolOptions, Object.values(tools), webSearchAvailable);

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="m-0 font-sans text-[13px]" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <ToolPermissionsEditor
        options={toolOptions}
        tools={tools}
        query={toolQuery}
        onQueryChange={setToolQuery}
        onChange={persist}
        subjectName={persona.name}
      />
    </div>
  );
}
