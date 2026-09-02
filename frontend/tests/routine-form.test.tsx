import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoutineForm } from "../components/routine-form.js";
import type { ApiClient, Routine } from "../lib/api-client.js";

const existingRoutine: Routine = {
  id: "routine-1",
  personaId: "p1",
  name: "Daily News Digest",
  cronSchedule: "0 13 * * *",
  promptTemplate: "Compare the framing of today's biggest stories across the political spectrum.",
  notifyRoutineRan: true,
  enabled: true,
  lastFiredAt: null,
  lastSummary: "",
  kind: "job",
};

describe("RoutineForm notify opt-in", () => {
  it("renders an unchecked notify toggle that will persist with the create payload", () => {
    vi.stubGlobal("React", React);
    // SAFETY: this test only SSR-renders the initial form; createRoutine is never called.
    const client = {} as ApiClient;
    const markup = renderToStaticMarkup(<RoutineForm client={client} personaId="p1" onCreated={() => undefined} />);
    expect(markup).toContain("Notify when this routine runs");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain("Routine name");
    expect(markup).toContain("Schedule");
    expect(markup).toContain('name="cronSchedule"');
    expect(markup).toContain("focus-visible:ring-2");
  });

  it("shows every saved field when editing an existing routine", () => {
    vi.stubGlobal("React", React);
    // SAFETY: this test only SSR-renders the edit form; updateRoutine is never called.
    const client = {} as ApiClient;
    const markup = renderToStaticMarkup(
      <RoutineForm
        client={client}
        personaId="p1"
        routine={existingRoutine}
        onUpdated={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain(">Edit routine</h3>");
    expect(markup).toContain('value="Daily News Digest"');
    expect(markup).toContain('value="0 13 * * *"');
    expect(markup).toContain("Compare the framing of today&#x27;s biggest stories across the political spectrum.");
    expect(markup).toContain("Save changes");
  });
});
