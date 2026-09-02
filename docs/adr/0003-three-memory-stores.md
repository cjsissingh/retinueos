# ADR 0003: Three memory stores, not one

- **Status:** Accepted
- **Date:** 2026-08-22 (plan); 2026-08-23 (revision: provenance, supersession, untrusted framing)

## Context

Loop state, durable facts, and conversation summaries have different lifecycles and trust boundaries. A single "memory"
table would mix a wholesale loop blob ("the inbox-suggestions list"), a small additive fact ("The operator prefers
concise replies"), and a chat/job summary. Folding a private thread summary into persona-wide memory would leak that chat
into every future job.

## Decision

Keep three stores:

| Store                   | Shape                                                                      | Tools / injection                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persona_state`         | One named blob per `(persona, key)`, overwritten wholesale                 | `read_state` / `write_state` / `list_state` / `forget_state`; bootstrap injects **key names + timestamps**, not content                                         |
| `persona_memories`      | Additive facts with provenance, supersession, sensitivity, expiry          | `remember` / `recall` / `forget_memory` / `promote_memory`; bootstrap injects a bounded, importance-then-recency slice of live, non-sensitive, non-expired rows |
| Job / routine summaries | Per-job thread hygiene (`job-summary:<jobId>`) and `routines.last_summary` | Job summaries are reserved-namespace, excluded from ordinary recall and cross-job injection                                                                     |

`remember` under an existing label supersedes the prior live row rather than silently overwriting. `recall` is bounded Postgres full-text search, not embeddings.

Injected state and memories are framed as **untrusted reference data, not instructions**. A memory that summarized a poisoned tool result must not replay as a system command.

Cross-persona sharing is opt-in `promote_memory` up the `reports_to` edge, not automatic fan-in.

## Consequences

- Digest generation can scan stale `persona_state` plus recent failed / waiting-approval jobs without reading fact memory.
- Vector/embedding search is out of scope until keyword recall fails in practice.
- The Memory panel lists durable memories today; loop-state visibility is a remaining UI gap, not a schema change.
- Do not merge these tables, and do not let generic memory tools mutate `job-summary:` rows.
