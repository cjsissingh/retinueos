import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolPermissionsEditor } from "../components/tool-permissions";
import { assignedConfigFor } from "../lib/tool-permissions";

const OPTIONS = [
  { id: "get_weather", label: "Get Weather", sourceName: "Built-in", riskClass: "read_only" as const },
  { id: "write_state", label: "Write own notes/state", sourceName: "Built-in", riskClass: "reversible" as const },
  { id: "send_email", label: "Send Email", sourceName: "Built-in", riskClass: "destructive" as const },
];

describe("ToolPermissionsEditor", () => {
  it("renders ChatGPT-style Allow / Ask / Blocked controls grouped by risk", () => {
    const markup = renderToStaticMarkup(
      <ToolPermissionsEditor
        options={OPTIONS}
        tools={{
          get_weather: assignedConfigFor("get_weather", "allow"),
          write_state: assignedConfigFor("write_state", "ask"),
        }}
        query=""
        onQueryChange={() => undefined}
        onChange={() => undefined}
        subjectName="Research Lead"
      />,
    );

    expect(markup).toContain("Tool permissions");
    expect(markup).toContain("Choose when Research Lead is allowed to use these tools.");
    expect(markup).toContain("Read-only tools");
    expect(markup).toContain("Write/delete tools");
    expect(markup).toContain("Get Weather");
    expect(markup).toContain("Write own notes/state");
    expect(markup).toContain("Send Email");
    expect(markup).toContain(">Allow<");
    expect(markup).toContain(">Ask<");
    expect(markup).toContain(">Block<");
    expect(markup).toContain("min-h-11");
    expect(markup).not.toContain("h-8 w-8");
    expect(markup).toContain("Destructive tools always require approval");
  });
});
