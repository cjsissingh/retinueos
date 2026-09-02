import { Hono } from "hono";
import { generateObject } from "ai";
import type { DrizzleDb } from "../db/client.js";
import { PersonaCreateSchema, PersonaUpdateSchema } from "./persona-schemas.js";
import { PersonaGenerateRequestSchema, PersonaGeneratedDraftSchema } from "./persona-generate-schemas.js";
import { createPersona, getPersona, updatePersona, wouldCreateReportingCycle } from "./persona-repo.js";
import { PersonaQueryService } from "../control/persona-query-service.js";
import type { PersonaRow } from "../db/schema.js";
import { normalizeAssignedTools } from "../tools/autonomy.js";
import { defaultRegistry } from "../tools/registry.js";
import { availableStarterTemplates, STARTER_PERSONA_TEMPLATES } from "./persona-templates.js";
import { getSettings, type Settings } from "../config.js";
import { resolveModel } from "../models/router.js";

function riskClassFor(toolId: string) {
  return defaultRegistry.has(toolId) ? defaultRegistry.get(toolId).riskClass : undefined;
}

const owner = { kind: "owner", source: "rest" } as const;

// Persona generation always drafts with a fixed model, independent of whatever model
// the resulting persona will actually run on (that's chosen separately, in
// the hire form) — this is a one-off assist call, not the persona's own
// config. Anthropic-only for now: there's no reliable current default
// OpenAI model id to fall back to without a live catalog fetch on every
// generate request, and shipping one path well beats guessing the other.
const GENERATION_PROVIDER = "anthropic";
const GENERATION_MODEL_NAME = "claude-sonnet-5";

// `createdAt` is an internal cursor key added for control-plane pagination;
// retain the established REST resource representation.
function restPersona({ createdAt: _createdAt, ...persona }: PersonaRow): Omit<PersonaRow, "createdAt"> {
  return persona;
}

export function personaRoutes(db: DrizzleDb, queryService?: PersonaQueryService, settings?: Settings): Hono {
  const app = new Hono();
  const service = queryService ?? new PersonaQueryService(db);

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = PersonaCreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    if (parsed.data.reportsTo) {
      const manager = await getPersona(db, parsed.data.reportsTo);
      if (!manager) return c.json({ error: "reportsTo: no such persona" }, 400);
    }
    const persona = await createPersona(db, {
      ...parsed.data,
      assignedToolIds: normalizeAssignedTools(parsed.data.assignedToolIds, riskClassFor),
    });
    return c.json(restPersona(persona), 201);
  });

  app.get("/", async (c) => c.json((await service.listAll(owner)).map(restPersona)));

  // Registered ahead of "/:id" so the literal segment "templates" can never
  // be swallowed by the id lookup — the starter templates, filtered to
  // whatever's actually registered on this deployment (e.g. no web_search
  // suggestion if no search API key is configured).
  app.get("/templates", async (c) => c.json(availableStarterTemplates(defaultRegistry)));

  app.get("/:id", async (c) => {
    const persona = await service.get(owner, c.req.param("id"));
    if (!persona) return c.json({ error: "persona not found" }, 404);
    return c.json(restPersona(persona));
  });

  // draft a persona from a freeform description, optionally
  // anchored to one of the starter templates. Never creates a
  // persona — returns a draft the frontend prefills into the same hire
  // form a template would, for the operator to review and submit.
  app.post("/generate", async (c) => {
    const body = await c.req.json();
    const parsed = PersonaGenerateRequestSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    if (!(settings ?? getSettings()).availableProviders.includes(GENERATION_PROVIDER)) {
      return c.json(
        { error: "AI persona generation requires an Anthropic API key. Configure ANTHROPIC_API_KEY to enable it." },
        422,
      );
    }

    const seedTemplate = parsed.data.seedTemplateSlug
      ? STARTER_PERSONA_TEMPLATES.find((t) => t.slug === parsed.data.seedTemplateSlug)
      : undefined;
    const knownTools = defaultRegistry.list().map((tool) => `- ${tool.id}: ${tool.description}`);

    const prompt = [
      "Draft a new AI persona for a personal-automation app based on what the operator describes below.",
      "Write systemPrompt as direct second-person instructions to the persona, the way a manager would brief a new hire.",
      seedTemplate
        ? `Use this existing starter as a jumping-off point, adjusting it to fit the operator's description rather than reusing it verbatim:\nName: ${seedTemplate.name}\nRole: ${seedTemplate.role}\nInstructions: ${seedTemplate.systemPrompt}`
        : null,
      `Operator's description: ${parsed.data.description}`,
      knownTools.length > 0
        ? `Only suggest tools this persona would actually need, using the exact id from this list:\n${knownTools.join("\n")}`
        : "No tools are currently available to suggest — return an empty defaultTools array.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n\n");

    let draft;
    try {
      ({ object: draft } = await generateObject({
        model: resolveModel(GENERATION_PROVIDER, GENERATION_MODEL_NAME),
        schema: PersonaGeneratedDraftSchema,
        prompt,
      }));
    } catch {
      return c.json(
        { error: "Couldn't generate a persona draft. Try describing it differently, or start from scratch." },
        502,
      );
    }

    return c.json({
      ...draft,
      // Never trust the model's tool ids as-is — same gate the
      // templates go through (availableStarterTemplates).
      defaultTools: draft.defaultTools.filter(({ toolId }) => defaultRegistry.has(toolId)),
    });
  });

  // Mutate a persona after hiring: identity, charter (systemPrompt/scope/
  // voice/boundaries), tools, model, and org chart position (null = top of
  // chart) can all change. Every field is optional and independent — a
  // PATCH only touches what it includes.
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await getPersona(db, id);
    if (!existing) return c.json({ error: "persona not found" }, 404);

    const body = await c.req.json();
    const parsed = PersonaUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    if (parsed.data.reportsTo) {
      const manager = await getPersona(db, parsed.data.reportsTo);
      if (!manager) return c.json({ error: "reportsTo: no such persona" }, 400);
      if (await wouldCreateReportingCycle(db, id, parsed.data.reportsTo)) {
        return c.json({ error: "reportsTo: would create a reporting cycle" }, 400);
      }
    }

    const patch =
      parsed.data.assignedToolIds === undefined
        ? parsed.data
        : {
            ...parsed.data,
            assignedToolIds: normalizeAssignedTools(parsed.data.assignedToolIds, riskClassFor),
          };
    const updated = await updatePersona(db, id, patch);
    if (!updated) return c.json({ error: "persona not found" }, 404);
    return c.json(restPersona(updated));
  });

  return app;
}
