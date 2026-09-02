import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PersonaSidePanel } from "../components/persona-side-panel.js";
import type { ApiClient, Memory, ModelCall, Persona, PersonaStateEntry, Routine } from "../lib/api-client.js";

function basePersona(): Persona {
  return {
    id: "p1",
    name: "Alex",
    role: "Ops",
    reportsTo: null,
    systemPrompt: "",
    scopeDescription: "",
    voiceNotes: "",
    boundaries: "",
    modelProvider: "anthropic",
    modelName: "claude",
    assignedToolIds: [],
    status: "idle",
    lastSummary: "",
  };
}

function baseRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "r1",
    personaId: "p1",
    name: "Morning digest",
    kind: "digest",
    promptTemplate: "Summarize overnight activity across the whole team.",
    cronSchedule: "0 8 * * *",
    enabled: true,
    notifyRoutineRan: false,
    lastFiredAt: null,
    lastSummary: "",
    ...overrides,
  };
}

function baseModelCall(overrides: Partial<ModelCall> = {}): ModelCall {
  return {
    id: "m1",
    jobId: "j1",
    personaId: "p1",
    provider: "anthropic",
    model: "claude-sonnet",
    finishReason: "stop",
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    latencyMs: 820,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("routine row overflow menu", () => {
  it("puts the name and schedule on one line and keeps the closed menu from being clipped", () => {
    vi.stubGlobal("React", React);
    // SAFETY: this only SSR-renders the panel's initial (closed-menu)
    // state -- no client method is ever called.
    const client = {} as ApiClient;
    const markup = renderToStaticMarkup(
      <PersonaSidePanel
        panel="routines"
        onClose={() => {}}
        persona={basePersona()}
        client={client}
        routines={[baseRoutine()]}
        onRoutineCreated={() => {}}
        onRoutineUpdated={() => {}}
        memories={[]}
        onMemoryDeleted={() => {}}
        loopState={[]}
        onLoopStateDeleted={() => {}}
        modelCalls={[]}
      />,
    );
    expect(markup).toContain("Morning digest");
    expect(markup).toContain("0 8 * * *");
    expect(markup).toContain("Actions for Morning digest");
    expect(markup).toContain("overflow-visible");
    // The menu is closed by default -- its items aren't in the initial markup.
    expect(markup).not.toContain("Edit details");
    expect(markup).not.toContain("Run now");
    expect(markup).not.toContain(">Pause<");
    expect(markup).not.toMatch(/role="menu"/);
  });
});

describe("model call row in the Model usage panel", () => {
  it("renders provider/model as the primary line and latency/tokens/time as one meta line", () => {
    vi.stubGlobal("React", React);
    // SAFETY: this only SSR-renders the panel's initial state -- no client
    // method is ever called.
    const client = {} as ApiClient;
    const markup = renderToStaticMarkup(
      <PersonaSidePanel
        panel="telemetry"
        onClose={() => {}}
        persona={basePersona()}
        client={client}
        routines={[]}
        onRoutineCreated={() => {}}
        onRoutineUpdated={() => {}}
        memories={[]}
        onMemoryDeleted={() => {}}
        loopState={[]}
        onLoopStateDeleted={() => {}}
        modelCalls={[baseModelCall()]}
      />,
    );
    expect(markup).toContain("Claude Sonnet");
    expect(markup).toContain("anthropic/claude-sonnet");
    expect(markup).toContain("100 in");
    expect(markup).toContain("140 total");
  });
});

describe("memory panel loop state", () => {
  it("renders named loop notes separately from durable facts", () => {
    vi.stubGlobal("React", React);
    // SAFETY: this only SSR-renders the panel's initial state -- no client
    // method is ever called.
    const client = {} as ApiClient;
    const loopState: PersonaStateEntry[] = [
      {
        id: "s1",
        personaId: "p1",
        key: "inbox-suggestions",
        content: "3 flagged",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const memories: Memory[] = [
      {
        id: "m1",
        personaId: "p1",
        label: "spouse",
        content: "Operator's spouse is named Sam",
        sourceJobId: null,
        supersedesId: null,
        supersededAt: null,
        sensitivity: "normal",
        importance: 1,
        expiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastAccessedAt: null,
      },
    ];
    const markup = renderToStaticMarkup(
      <PersonaSidePanel
        panel="memory"
        onClose={() => {}}
        persona={basePersona()}
        client={client}
        routines={[]}
        onRoutineCreated={() => {}}
        onRoutineUpdated={() => {}}
        memories={memories}
        onMemoryDeleted={() => {}}
        loopState={loopState}
        onLoopStateDeleted={() => {}}
        modelCalls={[]}
      />,
    );
    expect(markup).toContain("Loop notes");
    expect(markup).toContain("inbox-suggestions");
    expect(markup).toContain("3 flagged");
    expect(markup).toContain("Facts");
    expect(markup).toContain("spouse");
    expect(markup).toContain("Operator&#x27;s spouse is named Sam");
  });

  it("explains both empty stores instead of only mentioning facts", () => {
    vi.stubGlobal("React", React);
    // SAFETY: this only SSR-renders the panel's initial state -- no client
    // method is ever called.
    const client = {} as ApiClient;
    const markup = renderToStaticMarkup(
      <PersonaSidePanel
        panel="memory"
        onClose={() => {}}
        persona={basePersona()}
        client={client}
        routines={[]}
        onRoutineCreated={() => {}}
        onRoutineUpdated={() => {}}
        memories={[]}
        onMemoryDeleted={() => {}}
        loopState={[]}
        onLoopStateDeleted={() => {}}
        modelCalls={[]}
      />,
    );
    expect(markup).toContain("No loop notes yet");
    expect(markup).toContain("No durable memories yet.");
  });
});
