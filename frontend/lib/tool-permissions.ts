import type { AssignedToolConfig, RiskClass } from "@/lib/api-client";

export type ToolPermission = "allow" | "ask" | "blocked";

/**
 * Stored record → user-facing permission, ignoring the destructive ceiling.
 * Missing config is Blocked. Legacy rows without `permission` still load:
 * `autonomy: "approval_required"` is Ask; a bare `{ toolId }` is Allow.
 */
export function storedPermission(config: AssignedToolConfig | undefined): ToolPermission {
  if (!config) return "blocked";
  if (config.permission === "ask" || config.autonomy === "approval_required") return "ask";
  return "allow";
}

/**
 * Runtime / settings permission after the destructive ceiling. Destructive
 * tools are always Ask when assigned — they cannot be silently Allow.
 */
export function effectivePermission(riskClass: RiskClass, config: AssignedToolConfig | undefined): ToolPermission {
  if (!config) return "blocked";
  if (riskClass === "destructive") return "ask";
  return storedPermission(config);
}

/** Canonical stored row for Allow or Ask. Blocked is omitting the row. */
export function assignedConfigFor(toolId: string, permission: "allow" | "ask"): AssignedToolConfig {
  if (permission === "ask") return { toolId, permission: "ask", autonomy: "approval_required" };
  return { toolId, permission: "allow" };
}

/**
 * Build the stored config for a requested permission. Destructive + Allow
 * is coerced to Ask. Blocked returns undefined (drop from the assigned array).
 */
export function configForPermission(
  toolId: string,
  permission: ToolPermission,
  riskClass: RiskClass,
): AssignedToolConfig | undefined {
  if (permission === "blocked") return undefined;
  const coerced = riskClass === "destructive" && permission === "allow" ? "ask" : permission;
  return assignedConfigFor(toolId, coerced);
}

export function setToolPermission(
  configs: Record<string, AssignedToolConfig>,
  toolId: string,
  permission: ToolPermission,
  riskClass: RiskClass,
) {
  const next = { ...configs };
  const config = configForPermission(toolId, permission, riskClass);
  if (config) next[toolId] = config;
  else delete next[toolId];
  return next;
}

export type GroupPermission = ToolPermission | "custom";

export function groupPermission(
  options: Array<{ id: string; riskClass: RiskClass; unavailable?: boolean }>,
  configs: Record<string, AssignedToolConfig>,
): GroupPermission {
  const assignable = options.filter((option) => !option.unavailable);
  if (assignable.length === 0) return "blocked";
  const first = effectivePermission(assignable[0]!.riskClass, configs[assignable[0]!.id]);
  for (const option of assignable.slice(1)) {
    if (effectivePermission(option.riskClass, configs[option.id]) !== first) return "custom";
  }
  return first;
}

export function setGroupPermission(
  configs: Record<string, AssignedToolConfig>,
  options: Array<{ id: string; riskClass: RiskClass; unavailable?: boolean }>,
  permission: ToolPermission,
) {
  let next = configs;
  for (const option of options) {
    if (option.unavailable) continue;
    next = setToolPermission(next, option.id, permission, option.riskClass);
  }
  return next;
}

export function partitionToolsByRisk<T extends { riskClass: RiskClass }>(options: T[]) {
  return {
    readOnly: options.filter((option) => option.riskClass === "read_only"),
    write: options.filter((option) => option.riskClass !== "read_only"),
  };
}

export function permissionLabel(permission: ToolPermission): string {
  if (permission === "allow") return "Always allow";
  if (permission === "ask") return "Ask";
  return "Blocked";
}
