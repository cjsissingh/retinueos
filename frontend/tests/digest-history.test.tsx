import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DigestHistoryList } from "@/components/digest-history-list";
import { DigestDetailView } from "@/components/digest-detail-view";
import type { Digest, Persona } from "@/lib/api-client";

function persona(): Persona {
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

function digest(overrides: Partial<Digest> = {}): Digest {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    personaId: "p1",
    routineId: null,
    generatedAt: "2026-01-01T00:00:00.000Z",
    content: "Sitting untouched: inbox-suggestions (untouched 2 days).",
    ...overrides,
  };
}

describe("digest history", () => {
  it("lists a digest preview that links to the detail page", () => {
    const markup = renderToStaticMarkup(<DigestHistoryList digests={[digest()]} personas={[persona()]} />);
    expect(markup).toContain("Sitting untouched: inbox-suggestions");
    expect(markup).toContain("Alex");
    expect(markup).toContain("/logs/digests/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(markup).toContain("aaaaaaaa");
  });

  it("shows scheduled vs on-demand origin on the detail view", () => {
    const onDemand = renderToStaticMarkup(<DigestDetailView digest={digest()} persona={persona()} />);
    expect(onDemand).toContain("On demand");
    expect(onDemand).toContain("Sitting untouched: inbox-suggestions");
    expect(onDemand).toContain("/logs?view=digests");

    const scheduled = renderToStaticMarkup(
      <DigestDetailView digest={digest({ routineId: "r1" })} persona={persona()} />,
    );
    expect(scheduled).toContain("Scheduled digest");
  });
});
