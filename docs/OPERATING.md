# Operating RetinueOS

How to run RetinueOS day to day once it's deployed: hiring personas, setting
what they're allowed to do, scheduling their recurring work, and handling
what they can't finish without you. This is the operator how-to; product
philosophy and screen layout are [`docs/DESIGN.md`](DESIGN.md), architecture
decisions are [`docs/adr/`](adr/README.md).

## Personas

A persona is a named, LLM-backed staff member — not a raw chat session. Each
one has an identity (name, avatar mark, model), a charter (its instructions
and purpose), a set of tools it's allowed to call, and optionally a manager
it reports to.

Hire one from **Roster** (`/roster`) → **Hire a persona**. You can start
from a starter template (a pre-written charter and tool set for a common
role — Personal Assistant, Fitness Coach, Life Coach, or Researcher),
generate a draft from a short description, or write one from scratch.
Every persona can be edited afterward from its
workspace (`/roster/:id/manage`), which has one tab per concern:

| Tab      | Controls                                                |
| -------- | ------------------------------------------------------- |
| Identity | Name, avatar mark, model                                |
| Charter  | The system prompt: purpose, boundaries, tone            |
| Tools    | Which tools it can call, and at what permission (below) |
| Team     | Who reports to this persona, and who it reports to      |
| Routines | Its recurring, scheduled jobs (below)                   |
| Memory   | Durable facts it has written about itself or its work   |
| Usage    | Token/cost telemetry for its model calls                |

Deleting a persona is available from Identity; it's a destructive action
with its own confirmation.

### Tool permission

Every tool assigned to a persona has one of three permission levels:

- **Blocked** — the persona can't see or call it. Default for anything not
  explicitly assigned.
- **Ask** — the persona can call it, but the run pauses for your approval
  first (see Approvals below).
- **Allow** — the persona calls it directly, no pause.

Tools carry a risk class — **read-only**, **reversible**, or
**destructive** — set when the tool (native or MCP) is registered.
Destructive tools have a hard ceiling: they can never be stored as Allow,
regardless of what the persona's settings say. Ask is the most autonomy a
destructive action can have. This is enforced in the permission model
itself (`backend/src/tools/autonomy.ts`), not just in the UI, so a persona
can't talk its way past it in chat or a routine run. It governs persona
tool execution specifically — direct REST and control-plane MCP operations
(managing routines, resolving approvals, and so on) go through their own
actor/scope policy instead ([ADR 0005](adr/0005-control-plane-shared-policy.md)),
not this ceiling.

### Delegation and the org chart

A persona with the `delegate_to` tool can hand a task to any other persona
in the roster by id — delegation isn't currently restricted to a manager
or direct report, whatever the Team tab shows. Delegation has two hard
caps, checked on every delegate call, not just suggested by the UI:

- **Depth 3** — a chain of delegations can go at most three hops deep.
- **10 descendants** — a single root job can spawn at most ten delegated
  jobs in total, across the whole chain.

Both caps exist so a misconfigured or looping delegation can't fan out
into an unbounded number of model calls. The reporting graph itself
(`reports_to`) is also enforced acyclic — you can't set a persona to report
to one of its own reports, even transitively.

## Routines

A routine is a persona's recurring job: a task description plus a cron
schedule. Manage them from a persona's **Routines** tab — routines belong
to one persona, there's no cross-persona routines page. Each run creates a
normal job, subject to the same tool permissions and approval pauses as
anything else that persona does; a routine on a cron schedule doesn't get
more autonomy than the persona already has.

A routine can be paused (schedule stops firing, definition kept) or
deleted. Running one manually — "run now" — doesn't disturb its schedule.

## Approvals

When a persona calls a tool at Ask permission, its run pauses and waits.
That's an approval: a specific tool call, with the arguments the model
chose, sitting in front of you until you decide.

Approvals surface in three places, all backed by the same underlying
record — nothing exists only as a notification:

- **Today** (`/today`) — anything waiting on you, across every persona, is
  the first thing on the landing screen.
- **Approvals** (`/approvals`) — every open approval, one list.
- Inline in the persona's own **chat** (`/roster/:id`), where you can see
  the surrounding conversation.

Each approval shows the tool, the risk class, and the arguments in
readable form (not a raw JSON blob). You can **Approve** (run it) or
**Decline** (tell the persona no) — there's no reason field to send back
with a decline yet. Because an approval also surfaces inline in the
persona's chat, you can read the surrounding conversation and reply there
before deciding, without a dedicated "ask a question" control on the
approval card itself. Approvals are never optimistic, queued offline, or
retried automatically — the side effect only happens once you say so, and
if you're offline when one comes in, it's still there, waiting, when
you're back.

## Connections

Personas reach external services — Gmail, Calendar, anything else exposed
over MCP — through **Connections** (`/settings/mcp`). That's a full guide
on its own: see [`docs/CONNECTORS.md`](CONNECTORS.md) for adding a server,
confirming risk classes, and the Gmail/Calendar walkthrough.

To connect an external MCP client _into_ RetinueOS instead — the reverse direction — see
[`docs/CONTROL_PLANE_MCP.md`](CONTROL_PLANE_MCP.md).

## Everything else that needs you

- **Logs** (`/logs`) — every job, its status, and its full transcript.
- **Audit** (`/audit`) — every tool call, at whatever stage: pending,
  approved, declined, executed, or failed. Not only calls that ran.
- **Notifications** (`/notifications`, **Settings → Notifications**) — push
  and webhook delivery for job/routine outcomes; see the README's
  [Browser notifications](../README.md#browser-notifications) section for
  setup.
- **Settings → Access** (`/settings/access`) — the bearer token and MCP URL for connecting external clients.
