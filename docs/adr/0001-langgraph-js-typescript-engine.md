# ADR 0001: Per-persona LangGraph.js engine in TypeScript

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

RetinueOS needs a resumable, provider-agnostic execution engine for interactive, scheduled, and delegated persona work.

Four failure modes from the original review still apply:

1. Unattended destructive tool execution.
2. Context and cost blowup on long or resumed sessions.
3. Client/server contract drift.
4. Cron work blocking the serving process.

## Decision

Each persona execution (chat turn, scheduled routine, delegated task) is its own LangGraph.js run. LangGraph's Postgres checkpointer holds conversation state; its `interrupt()` is the destructive-tool approval gate. A thin `jobs` / `job_attempts` / `tool_calls` layer in the same Postgres instance tracks what LangGraph does not: persona ownership, delegation depth and parent linkage, trigger origin, and UI-queryable status.

The runtime is TypeScript throughout: Hono backend, Vercel AI SDK for model routing, Drizzle for app tables, `node-cron` in-process, Next.js frontend over REST and SSE. Docker Compose is the self-host path. The app is a single shared instance gated by `AUTH_PASSWORD`. LLM provider keys stay in environment variables; the app never stores them.

Rejected alternatives:

- **Python / FastAPI / LiteLLM.** Same architecture, wrong language for the people maintaining this.
- **Custom Postgres job queue with LangGraph only inside a job.** Reimplements persistence, resumability, and human-in-the-loop pause that LangGraph already provides.
- **One LangGraph graph for the whole roster.** Cross-persona concerns (scheduler, flat approval queue, roster) are not one agent's reasoning.
- **Collapse the backend into Next.js route handlers.** The scheduler and SSE streams need a long-lived process.

## Consequences

- Destructive calls pause via `interrupt()` in the dispatch path regardless of origin (user, cron, delegation). Prompt text is not the enforcement mechanism.
- Interactive chat may resume a thread. Cron and delegated runs start a **new** thread so unattended context cannot grow without bound.
- Delegation is a tool grant, not a role. Depth and descendant caps live on `jobs`, not in a persona prompt.
- The backend stays a separate container so a future native companion can use the same API. Infra stays agnostic: no Vercel Cron, no cloud-specific services in app code.
- Schema and product have grown past this ADR (routines, memory, MCP, control-plane MCP) without replacing the orchestration shape. Those later decisions are 0002–0005.
