import type { DrizzleDb } from "../db/client.js";
import type { PersonaRow } from "../db/schema.js";
import { getPersona, listPersonas, listPersonasPage } from "../personas/persona-repo.js";
import { ControlError, type ControlActor, type PageRequest, type PageResult } from "./types.js";

function requireRead(actor: ControlActor): void {
  if (actor.kind === "mcp_client" && !actor.scopes.includes("personas:read")) {
    throw new ControlError("insufficient_scope", "missing required scope: personas:read");
  }
}

/** Shared read boundary for REST and future MCP persona operations. */
export class PersonaQueryService {
  constructor(private db: DrizzleDb) {}

  async listAll(actor: ControlActor): Promise<PersonaRow[]> {
    requireRead(actor);
    const rows = await listPersonas(this.db);
    return actor.kind === "persona" ? rows.filter((row) => row.id === actor.personaId) : rows;
  }

  async listPage(actor: ControlActor, page: PageRequest = {}): Promise<PageResult<PersonaRow>> {
    requireRead(actor);
    if (actor.kind !== "persona") return listPersonasPage(this.db, page);
    const row = await getPersona(this.db, actor.personaId);
    return { items: row ? [row] : [], nextCursor: null };
  }

  async get(actor: ControlActor, id: string): Promise<PersonaRow | undefined> {
    requireRead(actor);
    if (actor.kind === "persona" && actor.personaId !== id) {
      throw new ControlError("ownership_violation", "persona actors may only access their own persona");
    }
    return getPersona(this.db, id);
  }
}
