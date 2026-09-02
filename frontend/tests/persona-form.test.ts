import { describe, expect, it } from "vitest";
import { defaultAssignment, groupPersonaToolOptions, personaToolOptions } from "../components/persona-form";
import { buildPersonaFormValues } from "../lib/persona-form-values";

describe("buildPersonaFormValues", () => {
  it("builds the complete update payload without omitting or normalizing editable fields", () => {
    expect(
      buildPersonaFormValues({
        name: " Wren ",
        role: "Research lead",
        systemPrompt: "Find primary sources.",
        scopeDescription: "Research and synthesis",
        voiceNotes: "Clear, curious, concise",
        boundaries: "Never invent a citation",
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
        tools: {
          get_weather: { toolId: "get_weather" },
          send_email: { toolId: "send_email", permission: "ask" },
        },
        reportsTo: "persona-morgan",
      }),
    ).toEqual({
      name: " Wren ",
      role: "Research lead",
      systemPrompt: "Find primary sources.",
      scopeDescription: "Research and synthesis",
      voiceNotes: "Clear, curious, concise",
      boundaries: "Never invent a citation",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-5",
      assignedToolIds: [{ toolId: "get_weather" }, { toolId: "send_email", permission: "ask" }],
      reportsTo: "persona-morgan",
    });
  });
});

describe("personaToolOptions", () => {
  it("offers web search only when the backend reports it available", () => {
    expect(personaToolOptions([], [], false).map(({ id }) => id)).not.toContain("web_search");
    expect(personaToolOptions([], [], true)).toContainEqual({
      id: "web_search",
      label: "Search the web",
      sourceName: "Built-in",
      riskClass: "read_only",
    });
  });

  it("exposes native routine tools in the Routine management group", () => {
    const routine = personaToolOptions([], []).filter(({ groupKey }) => groupKey === "routine-management");

    expect(routine.map(({ id }) => id)).toEqual([
      "list_own_routines",
      "create_own_routine",
      "update_own_routine",
      "pause_own_routine",
      "resume_own_routine",
      "run_own_routine_now",
      "delete_own_routine",
    ]);
    expect(routine.every(({ sourceName }) => sourceName === "Routine management")).toBe(true);
  });

  it("defaults routine assignment autonomy by risk", () => {
    const routine = personaToolOptions([], []).filter(({ groupKey }) => groupKey === "routine-management");

    expect(defaultAssignment(routine.find(({ id }) => id === "list_own_routines")!)).toEqual({
      toolId: "list_own_routines",
    });
    expect(defaultAssignment(routine.find(({ id }) => id === "create_own_routine")!)).toEqual({
      toolId: "create_own_routine",
      autonomy: "approval_required",
    });
    expect(defaultAssignment(routine.find(({ id }) => id === "delete_own_routine")!)).toEqual({
      toolId: "delete_own_routine",
      autonomy: "approval_required",
    });
  });

  it("does not offer retired native Gmail or Calendar tools", () => {
    const ids = personaToolOptions([], []).map(({ id }) => id);

    expect(ids).not.toContain("gmail_search");
    expect(ids).not.toContain("gmail_label");
    expect(ids).not.toContain("gmail_draft_reply");
    expect(ids).not.toContain("calendar_create_event");
  });

  it("keeps an unavailable assigned MCP tool visible and removable", () => {
    const staleId = "mcp:deleted-server:old-tool";
    const options = personaToolOptions([], [{ toolId: staleId, autonomy: "approval_required" }]);

    expect(options).toContainEqual({
      id: staleId,
      label: `Unavailable MCP tool: ${staleId}`,
      sourceName: "Unavailable",
      riskClass: "reversible",
      unavailable: true,
    });
  });

  it("does not duplicate an assigned MCP tool that remains available", () => {
    const id = "mcp:server:read";
    const options = personaToolOptions(
      [{ id, label: "read", sourceName: "Server", riskClass: "read_only" }],
      [{ toolId: id }],
    );

    expect(options.filter((option) => option.id === id)).toEqual([
      { id, label: "read", sourceName: "Server", riskClass: "read_only" },
    ]);
  });

  it("does not flash an already-assigned MCP tool as unavailable while its catalog is still loading", () => {
    // null = "haven't heard back from listAvailableMcpTools yet", distinct
    // from `[]` ("heard back, this tool really isn't in the catalog").
    const id = "mcp:server:read";
    const options = personaToolOptions(null, [{ toolId: id }]);

    expect(options.find((option) => option.id === id)).toBeUndefined();
  });

  it("groups built-in and MCP tools by their explicit source name", () => {
    const options = personaToolOptions(
      [
        { id: "mcp:gmail:search", label: "Search mail", sourceName: "Gmail", riskClass: "read_only" },
        { id: "mcp:calendar:list", label: "List events", sourceName: "Calendar", riskClass: "read_only" },
      ],
      [],
    );

    const groups = groupPersonaToolOptions(options, "");

    expect(groups.map(({ sourceName }) => sourceName)).toEqual(["Built-in", "Routine management", "Gmail", "Calendar"]);
    expect(groups[2]?.options.map(({ id }) => id)).toEqual(["mcp:gmail:search"]);
  });

  it("searches tool names and source names without leaving empty groups", () => {
    const options = personaToolOptions(
      [
        { id: "mcp:gmail:search", label: "Search mail", sourceName: "Gmail", riskClass: "read_only" },
        { id: "mcp:calendar:list", label: "List events", sourceName: "Calendar", riskClass: "read_only" },
      ],
      [],
    );

    expect(groupPersonaToolOptions(options, "gmail").map(({ sourceName }) => sourceName)).toEqual(["Gmail"]);
    expect(groupPersonaToolOptions(options, "events")[0]?.options.map(({ id }) => id)).toEqual(["mcp:calendar:list"]);
  });
});
