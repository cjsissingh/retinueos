// backend/src/tools/autonomy.ts
import type { AssignedToolConfig, ToolPermission } from "../db/schema.js";
import type { RiskClass, ToolSpec } from "./registry.js";

export type { ToolPermission };

/**
 * Stored record → user-facing permission, ignoring the destructive ceiling.
 * Missing config is Blocked (assigned vs not is the off switch). Legacy
 * rows without `permission` still load: `autonomy: "approval_required"` is
 * Ask; a bare `{ toolId }` is Allow.
 */
export function storedPermission(config: AssignedToolConfig | undefined): ToolPermission {
  if (!config) return "blocked";
  if (config.permission === "ask" || config.autonomy === "approval_required") return "ask";
  return "allow";
}

/**
 * Runtime permission after the destructive ceiling. Destructive tools are
 * always Ask when assigned — there is no stored value that silently becomes
 * Allow (see AssignedToolConfig in schema.ts). Unassigned is Blocked.
 */
export function effectivePermission(
  spec: Pick<ToolSpec, "riskClass">,
  config: AssignedToolConfig | undefined,
): ToolPermission {
  if (!config) return "blocked";
  if (spec.riskClass === "destructive") return "ask";
  return storedPermission(config);
}

/**
 * Whether a call to this tool must pause for approval, for this persona.
 *
 * Ask is gated. Allow runs directly. Blocked is not gated — the caller must
 * refuse those tools separately so they never execute and never prompt.
 */
export function isGated(spec: Pick<ToolSpec, "riskClass">, config: AssignedToolConfig | undefined): boolean {
  return effectivePermission(spec, config) === "ask";
}

export function configFor(configs: AssignedToolConfig[], toolId: string): AssignedToolConfig | undefined {
  return configs.find((c) => c.toolId === toolId);
}

/** Canonical stored row for Allow or Ask. Blocked is omitting the row. */
export function assignedConfigFor(toolId: string, permission: "allow" | "ask"): AssignedToolConfig {
  if (permission === "ask") return { toolId, permission: "ask", autonomy: "approval_required" };
  return { toolId, permission: "allow" };
}

/**
 * Build the stored config for a requested permission. Destructive + Allow
 * is coerced to Ask so a PATCH cannot silently store Allow. Blocked
 * returns undefined (drop the tool from the assigned array).
 */
export function configForPermission(
  toolId: string,
  permission: ToolPermission,
  riskClass: RiskClass | undefined,
): AssignedToolConfig | undefined {
  if (permission === "blocked") return undefined;
  const coerced = riskClass === "destructive" && permission === "allow" ? "ask" : permission;
  return assignedConfigFor(toolId, coerced);
}

/**
 * Canonicalize assigned-tool rows on write: drop Blocked, coerce destructive
 * Allow → Ask, and emit the explicit `permission` field so new rows aren't
 * ambiguous with legacy `{ toolId }` records.
 */
export function normalizeAssignedTools(
  configs: AssignedToolConfig[],
  riskClassFor: (toolId: string) => RiskClass | undefined,
): AssignedToolConfig[] {
  const out: AssignedToolConfig[] = [];
  for (const config of configs) {
    const next = configForPermission(config.toolId, storedPermission(config), riskClassFor(config.toolId));
    if (next) out.push(next);
  }
  return out;
}

/**
 * Always allow this tool for this persona — persists across jobs and
 * routine runs because the next run loads assignedToolIds from the persona
 * row. Destructive tools cannot be Always-allowed (returns undefined).
 * The tool must already be assigned (an Ask prompt only exists for assigned
 * tools); missing rows also return undefined rather than expanding the set.
 */
export function persistAlwaysAllow(
  configs: AssignedToolConfig[],
  toolId: string,
  riskClass: RiskClass,
): AssignedToolConfig[] | undefined {
  if (riskClass === "destructive") return undefined;
  if (!configs.some((c) => c.toolId === toolId)) return undefined;
  return configs.map((c) => (c.toolId === toolId ? assignedConfigFor(toolId, "allow") : c));
}
