# Architecture Decision Records

Standing decisions that still constrain the code. Implementation history, status notes, and bug write-ups do not belong here.

| ADR                                             | Decision                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [0001](0001-langgraph-js-typescript-engine.md)  | Per-persona LangGraph.js runs plus a thin Postgres orchestration layer, TypeScript throughout |
| [0002](0002-external-tools-via-mcp-adapters.md) | External tools are `ToolSpec` adapters; remote HTTPS MCP first; no parallel execution path    |
| [0003](0003-three-memory-stores.md)             | Loop state, durable facts, and job/routine summaries stay three stores                        |
| [0004](0004-autonomy-can-only-tighten.md)       | A persona may restrict a tool, never weaken a destructive baseline                            |
| [0005](0005-control-plane-shared-policy.md)     | REST, control-plane MCP, and native tools share one actor-aware policy layer                  |

Operator how-tos stay next to the product, not here: [Operating RetinueOS](../OPERATING.md), [self-hosting](../SELF_HOSTING.md), [Connectors](../CONNECTORS.md), [control-plane MCP](../CONTROL_PLANE_MCP.md), [self-host Google Workspace MCP](../SELF_HOSTED_GOOGLE_WORKSPACE_MCP.md).
