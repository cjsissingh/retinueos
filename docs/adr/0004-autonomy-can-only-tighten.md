# ADR 0004: Per-persona autonomy can only tighten

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

Tool `riskClass` (`read_only` | `reversible` | `destructive`) is assigned when a tool is registered. Autonomy varies by
persona and domain: the same "create a calendar event" action can be direct for one persona and gated for another. A
global class cannot express that. A per-persona override that _lowers_ a destructive tool to Allow would defeat the
interrupt gate.

## Decision

Each persona stores assigned tools as `{ toolId, permission?: "allow" | "ask" }`. Unassigned is Blocked.

Effective permission is the **stricter** of the tool's baseline and the persona override:

- A `destructive` tool is never Allow. "Always allow" on Approvals cannot punch through that ceiling.
- A `read_only` or `reversible` tool may be raised to Ask for a given persona.

The gate lives in `tools/autonomy.ts` / the graph dispatch path, not in prompt text. Boundaries such as "never execute a trade" are enforced by not assigning the tool.

## Consequences

- Hire/edit UI is Allow / Ask / Block (plus Always allow for a non-destructive Ask), not a checkbox plus a hidden risk class.
- New connector tiers (MCP, custom scripts, browser agents) reuse this model; they do not invent a second notion of "needs approval."
- Domain-level tables (personal calendar vs work calendar) are still expressed as separate tools or separate MCP servers, not as a second axis on `AssignedToolConfig`.
