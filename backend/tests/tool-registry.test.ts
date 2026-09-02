import { describe, it, expect } from "vitest";
import { RoutineService } from "../src/control/routine-service.js";
import { registerBuiltinTools } from "../src/tools/builtin.js";
import { defaultRegistry, ToolRegistry, type ToolSpec } from "../src/tools/registry.js";
import { useTestDb } from "./setup/db.js";

const { db } = useTestDb();

type TestJsonValue = string | number | boolean | null | TestJsonValue[] | { [key: string]: TestJsonValue };

describe("tool registry", () => {
  it("registers native tools explicitly with their routine service dependency", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, {
      routineService: new RoutineService(db()),
      webSearchApiKey: "brave-test-key",
    });

    expect(registry.get("get_weather").riskClass).toBe("read_only");
    expect(registry.get("web_search").riskClass).toBe("read_only");
    expect(registry.get("list_own_routines").riskClass).toBe("read_only");
    expect(registry.get("delete_own_routine").riskClass).toBe("destructive");
  });

  it("get_weather is read_only and runs", async () => {
    const tool = defaultRegistry.get("get_weather");
    expect(tool.riskClass).toBe("read_only");
    const result = await tool.run({ city: "Boston" });
    expect(result.temperature).toBeDefined();
  });

  it("does not register web_search without a Brave API key", () => {
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, { routineService: new RoutineService(db()), webSearchApiKey: "  " });

    expect(registry.has("web_search")).toBe(false);
  });

  it("send_email is destructive", () => {
    const tool = defaultRegistry.get("send_email");
    expect(tool.riskClass).toBe("destructive");
  });

  it("aiSdkToolsFor returns only the requested ids", () => {
    const tools = defaultRegistry.aiSdkToolsFor(["get_weather"]);
    expect(Object.keys(tools)).toEqual(["get_weather"]);
  });

  it("compiles optional fields and every nested object for OpenAI strict schemas without mutating the source", () => {
    const registry = new ToolRegistry();
    const parameters = {
      type: "object",
      properties: {
        options: {
          type: "object",
          required: ["labels"],
          properties: {
            labels: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
            limit: { type: "integer", minimum: 1, default: 10 },
            mode: { type: ["string"], enum: ["full"] },
          },
        },
      },
    };
    registry.register({
      id: "nested_schema",
      riskClass: "read_only",
      description: "nested schema",
      parameters,
      run: async () => ({}),
    });

    const providerTool = registry.aiSdkToolsFor(["nested_schema"]).nested_schema as {
      inputSchema: { jsonSchema: Record<string, unknown> };
    };

    expect(providerTool.inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: {
        options: {
          type: ["object", "null"],
          required: ["labels", "limit", "mode"],
          properties: {
            labels: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: ["string", "null"] } },
                required: ["name"],
                additionalProperties: false,
              },
            },
            limit: { type: ["integer", "null"], minimum: 1 },
            mode: { type: ["string", "null"], enum: ["full", null] },
          },
          additionalProperties: false,
        },
      },
      required: ["options"],
      additionalProperties: false,
    });
    expect(parameters).not.toHaveProperty("additionalProperties");
    expect(parameters).not.toHaveProperty("required");
    expect(parameters.properties.options.properties.limit).toHaveProperty("default", 10);
  });

  it("gives every nested items schema a type so OpenAI strict mode accepts MCP List[List] tools", () => {
    const registry = new ToolRegistry();
    // Shape FastMCP/Pydantic emit for `values: Union[str, List[List]]` —
    // google_workspace_mcp `append_table_rows`. Inner `items: {}` is JSON
    // Schema "any" and is exactly the node OpenAI 400s on.
    registry.register({
      id: "mcp:sheets:append_table_rows",
      riskClass: "reversible",
      description: "Append rows to a structured table",
      origin: "mcp",
      parameters: {
        type: "object",
        required: ["user_google_email", "spreadsheet_id", "table_id", "values"],
        properties: {
          user_google_email: { type: "string" },
          spreadsheet_id: { type: "string" },
          table_id: { type: "string" },
          values: {
            anyOf: [
              { type: "string" },
              {
                type: "array",
                items: {
                  type: "array",
                  items: {},
                },
              },
            ],
          },
        },
      },
      run: async () => ({}),
    });

    const [providerTool] = Object.values(registry.aiSdkToolsFor(["mcp:sheets:append_table_rows"])) as Array<{
      inputSchema: { jsonSchema: Record<string, unknown> };
    }>;
    const values = (providerTool!.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>).values;

    expect(values).toMatchObject({
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: {
            type: "array",
            items: { type: ["boolean", "null", "number", "string"] },
          },
        },
      ],
    });
  });

  it("infers types for untyped MCP array items, enums, and tuple items", () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "mcp:server:untyped_shapes",
      riskClass: "read_only",
      description: "untyped shapes",
      origin: "mcp",
      parameters: {
        type: "object",
        required: ["openArray", "flaggedItems", "status", "pair"],
        properties: {
          openArray: { type: "array" },
          flaggedItems: { type: "array", items: true },
          status: { enum: ["open", "closed"] },
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      },
      run: async () => ({}),
    });

    const [providerTool] = Object.values(registry.aiSdkToolsFor(["mcp:server:untyped_shapes"])) as Array<{
      inputSchema: { jsonSchema: Record<string, unknown> };
    }>;
    const properties = providerTool!.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>;

    expect(properties.openArray).toEqual({
      type: "array",
      items: { type: ["boolean", "null", "number", "string"] },
    });
    expect(properties.flaggedItems).toEqual({
      type: "array",
      items: { type: ["boolean", "null", "number", "string"] },
    });
    expect(properties.status).toEqual({ type: "string", enum: ["open", "closed"] });
    expect(properties.pair).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
    });
  });

  it("emits strict-compatible schemas for every native tool", () => {
    const unsupported = new Set([
      "$schema",
      "default",
      "examples",
      "deprecated",
      "readOnly",
      "writeOnly",
      "contentEncoding",
      "contentMediaType",
      "patternProperties",
      "unevaluatedProperties",
      "propertyNames",
      "minProperties",
      "maxProperties",
      "unevaluatedItems",
      "contains",
      "minContains",
      "maxContains",
      "uniqueItems",
      "oneOf",
      "allOf",
      "not",
      "if",
      "then",
      "else",
      "dependentRequired",
      "dependentSchemas",
    ]);
    const inspect = (value: TestJsonValue, path = "$"): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => inspect(item, `${path}[${index}]`));
        return;
      }
      if (value === null || typeof value !== "object") return;
      const schema = value as Record<string, unknown>;
      for (const key of Object.keys(schema)) expect(unsupported.has(key), `${path}.${key}`).toBe(false);
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (types.includes("object")) {
        expect(schema.additionalProperties, path).toBe(false);
        expect(schema.properties, path).toEqual(expect.any(Object));
        expect(schema.required, path).toEqual(Object.keys(schema.properties as Record<string, unknown>));
      }
      Object.entries(schema).forEach(([key, item]) => inspect(item, `${path}.${key}`));
    };

    const tools = defaultRegistry.aiSdkToolsFor(defaultRegistry.list().map((tool) => tool.id));
    for (const [name, providerTool] of Object.entries(tools)) {
      const schema = (providerTool as { inputSchema: { jsonSchema: Record<string, unknown> } }).inputSchema.jsonSchema;
      expect(schema.type, name).toBe("object");
      inspect(schema, name);
    }
  });

  it("removes unsupported formats from MCP schemas while preserving OpenAI-supported formats", () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "mcp:gmail:create_draft",
      riskClass: "reversible",
      description: "Create a Gmail draft",
      parameters: {
        type: "object",
        required: ["content", "messageId"],
        properties: {
          content: { type: "string", format: "byte" },
          messageId: {
            type: "string",
            format: "uuid",
            enum: ["one"],
            "x-google-enum-descriptions": ["First value"],
          },
        },
      },
      origin: "mcp",
      run: async () => ({}),
    });

    const [providerTool] = Object.values(registry.aiSdkToolsFor(["mcp:gmail:create_draft"])) as Array<{
      inputSchema: { jsonSchema: Record<string, unknown> };
    }>;

    expect(providerTool!.inputSchema.jsonSchema).toMatchObject({
      properties: {
        content: { type: "string" },
        messageId: { type: "string", format: "uuid" },
      },
    });
    expect(
      (providerTool!.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>).content,
    ).not.toHaveProperty("format");
    expect(
      (providerTool!.inputSchema.jsonSchema.properties as Record<string, Record<string, unknown>>).messageId,
    ).not.toHaveProperty("x-google-enum-descriptions");
  });

  it("strips provider-only null placeholders from optional execution arguments recursively", () => {
    const registry = new ToolRegistry();
    const spec: ToolSpec = {
      id: "optional_arguments",
      riskClass: "read_only",
      description: "optional arguments",
      parameters: {
        type: "object",
        required: ["threadId", "requiredNullable"],
        properties: {
          threadId: { type: "string" },
          messageFormat: { type: "string" },
          requiredNullable: { type: ["string", "null"] },
          options: {
            type: "object",
            properties: { sensitive: { type: "boolean" } },
          },
        },
      },
      run: async () => ({}),
    };
    registry.register(spec);

    expect(
      registry.executionArgumentsFor(spec, {
        threadId: "thread-1",
        messageFormat: null,
        requiredNullable: null,
        options: { sensitive: null },
      }),
    ).toEqual({ threadId: "thread-1", requiredNullable: null, options: {} });
  });

  it("uses a readable deterministic alias for an MCP tool id", () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "mcp:server:get_thread",
      riskClass: "read_only",
      description: "Get a Gmail thread",
      parameters: { type: "object" },
      origin: "mcp",
      run: async () => ({}),
    });

    expect(Object.keys(registry.aiSdkToolsFor(["mcp:server:get_thread"]))).toEqual(["get_thread_63602569525cd917"]);
  });

  it("uses provider-safe aliases for MCP ids and resolves them to the original specs", () => {
    const registry = new ToolRegistry();
    const spec: ToolSpec = {
      id: "mcp:123e4567-e89b-12d3-a456-426614174000:files/read",
      riskClass: "read_only",
      description: "read",
      parameters: { type: "object" },
      origin: "mcp",
      run: async () => ({}),
    };
    registry.register(spec);

    const [modelName] = Object.keys(registry.aiSdkToolsFor([spec.id]));
    expect(modelName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(modelName).not.toBe(spec.id);
    expect(registry.resolveModelTool(modelName!)).toBe(registry.get(spec.id));
  });

  it("keeps punctuation-normalization collisions mapped to distinct specs", () => {
    const registry = new ToolRegistry();
    const first = "mcp:server:read/file";
    const second = "mcp/server/read:file";
    for (const id of [first, second]) {
      registry.register({
        id,
        riskClass: "read_only",
        description: id,
        parameters: { type: "object" },
        origin: "mcp",
        run: async () => ({ id }),
      });
    }

    const names = Object.keys(registry.aiSdkToolsFor([first, second]));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(registry.resolveModelTool(names[0]!).id).toBe(first);
    expect(registry.resolveModelTool(names[1]!).id).toBe(second);
  });
});
