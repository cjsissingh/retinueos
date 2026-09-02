import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatPage = readFileSync(new URL("../app/roster/[personaId]/page.tsx", import.meta.url), "utf8");

describe("persona management surface", () => {
  it("links from chat to a full management screen instead of opening management sheets", () => {
    expect(chatPage).toContain("href={`/roster/${persona.id}/manage`}");
    expect(chatPage).not.toContain("PersonaEditorSheet");
    expect(chatPage).not.toContain("PersonaSidePanel");
    expect(chatPage).not.toContain("openPanel");
  });
});
