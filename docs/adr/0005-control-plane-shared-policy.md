# ADR 0005: One control-plane policy layer for REST, MCP, and native tools

- **Status:** Accepted
- **Date:** 2026-08-25

## Context

The UI already mutated routines, jobs, and approvals over password-gated REST. Personas had no native tools for the same operations. External clients needed a stable agent interface. Three HTTP or tool stacks that each enforced authorization differently would drift.

## Decision

Protocol adapters call focused application services. They do not call each other over HTTP.

```
External client -> MCP adapter -----+
                                    |
RetinueOS UI -----> REST adapter ----->+-> Control-plane services
                                    |
Persona graph ---> native tools ----+
```

A trusted `ControlActor` is constructed from authenticated route or tool context, never from model arguments:

- Owner REST actor: current password-protected UI authority.
- MCP client: only operations in its token scopes.
- Persona: may list and mutate only routines whose `personaId` equals its actor id. Reporting relationships do not grant routine-management authority; a manager delegates and the report creates its own routine.

v1 transport is Streamable HTTP at `/mcp/control` with named bearer tokens (`control_clients`). v1 surface: read-only persona discovery, jobs, full routine lifecycle, approvals, control-audit inspection. Out of v1: persona administration, credential access, outbound MCP admin, arbitrary REST, raw database access, stdio.

OAuth 2.1 for hosted clients is a follow-up; it must reuse `control_clients` identity and scopes, not a second policy.

## Consequences

- Native routine tools and MCP tools cannot bypass the same validation, scheduler reconciliation, idempotency, and audit path the UI uses.
- RetinueOS never connects to its own MCP endpoint; personas call `RoutineService` directly.
- Hosted OAuth, extra capabilities, a stdio bridge, and rate limits are future work, not implicit scope of this ADR.
