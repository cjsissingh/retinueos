# RetinueOS design guide

Read this before adding or changing any screen. Code and tests still win when an older example below disagrees with
the current application.

---

## 1. What this product is

A person manages a small staff. Not a job queue, not a chat app with extra tabs.

Three consequences that decide most arguments:

1. **The operator is the fallback for a blocked agent.** Anything that stops work — an approval,
   a question, a failed job, a broken connector — is the highest-priority thing on the screen and
   cannot be silenced.
2. **Personas are people-shaped.** They have a name, a mark, a voice, a charter, boundaries, and a
   manager. They are never "agent #3".
3. **The app is used away from the desk.** A phone in one hand at a bus stop is a first-class
   context, not a degraded one.

## 2. Decision rules

Apply in order. A lower rule never overrides a higher one.

1. **Can the operator act, here, now?** If a screen shows a thing that needs a decision, the
   decision controls are on that screen. No "go to the other page to approve".
2. **One surface per concept.** If a field is editable in two places, one of them is a bug.
3. **Ephemeral must have a durable twin.** A toast, a push, a live SSE event — each one is a _view_
   of a stored record. Nothing important exists only in a notification.
4. **Nothing renders that says nothing.** No empty-section cards, no "0 items", no placeholder
   illustration, no stat nobody acts on. An empty-feeling section is a layout problem.
5. **Loud is a budget.** Per screen, at most one element gets a coloured border. It is always the
   thing that needs a decision.
6. **Say it in the operator's words.** Every user-facing value leads with its readable name: people, tools, models,
   scopes, statuses, and saved objects. `gmail.send_message`, `waiting_approval`, UUIDs, and provider slugs are
   supporting technical metadata, never headlines. The headline is “Wren wants to send a reply to Katherine Bell.”
7. **Never guess a side effect.** Approvals are never optimistic, never queued offline, never
   retried automatically.

## 3. Tokens — the only vocabulary

Defined in `app/globals.css`, exposed via `tailwind.config.ts`. **No component names a raw hex or a
`slate-*` / `amber-*` utility.** Both themes are first-class; every value below has a dark pair.

| Group          | Tokens                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Canvas         | `--bg` `--surface` `--surface-sunken`                                                                                    |
| Line           | `--border` `--border-strong`                                                                                             |
| Ink            | `--fg` `--fg-muted` `--fg-faint`                                                                                         |
| Accent (brass) | `--accent` `--accent-fg` `--accent-soft` `--accent-soft-fg` `--accent-soft-border`                                       |
| Status         | `--running` (teal) `--warning` (amber) `--success` (green) `--danger` (rust) `--neutral`, each with `-soft` / `-soft-fg` |
| Depth          | `--shadow-rest` `--shadow-hover` `--shadow-overlay`                                                                      |
| Type           | `--font-serif` Instrument Serif · `--font-sans` IBM Plex Sans · `--font-mono` IBM Plex Mono                              |

### Colour meaning is fixed

- **Brass** — the operator's own actions and the current selection. Never a status.
- **Teal** — running / in flight.
- **Amber** — needs you. The only colour allowed to carry a count.
- **Green** — succeeded, and the Approve action.
- **Rust** — failed, declined, and irreversible side effects (boundaries, "sends mail").
- **Neutral** — paused, skipped, unknown.

Maximum two background colours per screen. Status colour arrives via `-soft` fills and small
badges, never as a large area.

### Type roles

- **Serif** — screen titles, greetings, persona names in headers. Never a control label.
- **Sans** — everything a person reads or clicks. 13–14px body, 15–17px on phone.
- **Mono, uppercase, tracked, 10–11px** — metadata, timestamps, counts, section eyebrows, tool ids.
  If it's a number the operator only glances at, it's mono.

## 4. Component vocabulary

Reuse these before writing anything new.

| Component                              | Rule                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persona-avatar`                       | Colour + monogram _is_ persona identity. Same mark in the roster, the chat header, an approval, a notification, a toast. Never a generic robot glyph.                                                                                           |
| `status-badge` / `derivePersonaStatus` | Only four persona states: `idle` · `on_it` · `needs_you` · `stuck`. Don't invent a fifth in a component.                                                                                                                                        |
| `risk-frame` / `RiskBadge`             | Risk class comes from the tool renderer registry, never from a string match on the tool id.                                                                                                                                                     |
| `approval-item`                        | The one approval control. Whatever container it sits in (Today, chat, notification centre, Approvals page), the post logic is this component's.                                                                                                 |
| `empty-state` / `error-state`          | Errors name the failed call and reassure ("GET /personas failed. Nothing has been lost."), then offer retry.                                                                                                                                    |
| `toast`                                | Needs-you toasts persist; outcome toasts auto-dismiss at 6s; max 3 stacked. Dismiss ≠ read.                                                                                                                                                     |
| Sheet                                  | _One_ overlay primitive for short, interruptible tasks: drag handle, swipe-dismiss, backdrop, `Esc`, focus trap, safe-area padding. Long forms, management, and anything with internal navigation get a page. No bespoke overlay class strings. |

### Control semantics

- A **toggle** changes one persistent binary setting immediately: enabled/disabled, notify/don't notify.
- A **checkbox** adds an item to or removes it from a set: selecting several access scopes or several tools for a
  bulk action. Checkboxes are not styled as toggles, and toggles are not used for batch selection.
- A **segmented control** chooses exactly one value from a small, stable set. Every segment has a visible text label;
  icon-only three-way controls are prohibited.
- A **button** performs an explicit action. Destructive buttons require confirmation or an undo window.

## 5. Layout model

```
< 768        bottom bar, 5 tabs (Today · Approvals · Chats · Roster · More), sheets for the rest
768 – 1179   icon-only 64px sidebar, labels on hover
>= 1180      full 240px sidebar
```

Non-negotiables:

- **44px minimum** hit target everywhere (`TOUCH_TARGET`, `PRIMARY_BUTTON` in `lib/touch-layout.ts`).
- **No horizontal scrolling** on any route at 390px. The only exception is the org chart's
  Structure view. Multi-column data grids (Logs, Audit, Model usage, routines) become two-line rows
  below `md`: primary line, then `status · time · numbers` in mono.
- **Layout contracts live in `lib/*-layout.ts`** as exported class strings so tests can lock them
  without mounting the shell. If you add a layout rule, add it there.
- Flex/grid + `gap`. Never margin-per-child or whitespace-as-spacing.
- Safe areas: `env(safe-area-inset-bottom)` on anything pinned to the bottom.
- `100dvh` + `visualViewport` offset for the chat column, so the composer sits on the keyboard.

## 6. Screen structure maps

### §01 Today — `/today`, the landing screen

```
greeting (serif) + one line of state
[ Ask someone to…            personas ▸        Send ]
NEEDS YOU ─────────────────────────────────── 3
  ┌ mark  Wren wants to send a reply to Katherine Bell   [sends mail]
  │       gmail.send_message · "Happy to move Tuesday…"
  └ [Approve] [Decline] [Open chat]              waiting 41m
IN FLIGHT ──────────────────────────────────────
  mark  Wren · clearing the overnight inbox — 14 of 31        ● 4m
DONE TODAY (collapsed after 5)
```

Order is fixed. Empty sections don't render. Empty day = greeting + composer + "Nobody's waiting
on you."

### §02 Chat — `/roster/:id`

```
[chats rail 260 | reading column                                  ]
                 header: persona · status · readable model [Manage]
                 ── Today · 08:04 ──
                                        user turn (accent-soft, right)
                 persona turn (plain text, mark on first of a run)
                 ( gmail · searched, read 31, archived 14 · 1.9s ▸ )
                 ┌ NEEDS APPROVAL · gmail.send_message ────────┐
                 │ payload preview                             │
                 │ [Approve & send] [Edit first] [Decline]     │
                 └─────────────────────────────────────────────┘
                 mark(35%) Wren is working…
                 composer: text · [✓ notify me when done] [attach] [Send ⏎]
```

- Consecutive tool calls in one turn collapse into one activity pill; **failures never collapse**.
- Persona configuration is never an overlay over the conversation. **Manage** opens the persona workspace; there is
  no icon rail and no second editing surface.
- Phone: title is the chat switcher; the chats sidebar is not in the DOM below `md`.

### §03 Persona workspace — `/roster/:id/manage?section=…`

```
mark  Wren · Inbox & scheduling · readable model          [Back to chat]
[ Identity  ] | one focused management section, one aspect of the persona
[ Charter   ] | readable values lead
[ Tools   9 ] | raw IDs remain secondary
[ Team    2 ] | long forms use the page width
[ Routines 3] |
[ Memory 14 ] |
[ Usage     ] |
```

Every nav row _is_ the form for that aspect — there is no generic "Profile" that duplicates fields the other
sections already own. Rows backed by a list (Tools, Team, Routines, Memory) show their count; Identity,
Charter, and Usage don't carry one. Each section saves itself with its own Save button, replacing the
original sticky dirty-section bar — don't reintroduce that or the Profile/Instructions split.

Chat and management are peer destinations with stable URLs. Row-level actions (Pause, Run now, Forget, permission
changes) save immediately — Tools follows this too: toggling a permission writes on the spot, no Save button.
Long configuration forms never open in a side sheet. Destructive actions live away from the primary Save action.

### §04 Notifications

One durable row per event; push / in-app / digest are channels over it.

```
kind = approval_needed | question | job_finished | job_failed | routine_ran | connector_broke
row  = kind, personaId?, jobId?, toolCallId?, title, body, createdAt, readAt, actedAt
```

- Badge = **unread needs-you count**, never total unread.
- `forced` channels (approval, question, failure, connector) cannot be turned off.
- Quiet hours hold _push only_; in-app rows still land so the morning list is complete.
- Acting anywhere sets `actedAt` and propagates over the workspace SSE stream.

### §05 Mobile / PWA

`start_url: /today`, `display_override: ["standalone"]`, shortcuts for Ask and Approvals,
per-theme `theme_color`. Offline: shell Today + notification centre + last chat; amber strip
under the header; composer queues; **approvals disabled with a reason**.

## 7. Copy

- Plain, brisk, no exclamation marks, no emoji.
- Subject-verb-object about a _person_: "Wren archived 212 messages." Not "Job completed
  successfully."
- Numbers in mono, words in sans.
- Errors: what failed, what is safe, what to do. Three clauses max.
- Never "AI", "agent", "LLM", "prompt" in operator-facing copy. It's a persona doing work.
- Sentence case for labels. Title Case only for product nouns (RetinueOS, Today, Approvals).

## 8. Adding a screen — checklist

- [ ] Which decision does this screen let the operator make? If none, it's a section of an existing
      screen, not a new one.
- [ ] Draw it at 390px first. It fits, or the specification changes.
- [ ] Tokens only. Both themes checked.
- [ ] One coloured border, maximum. It's on the decision.
- [ ] Loading (skeleton), empty (no filler), error (names the call), offline.
- [ ] Every target ≥ 44px; layout strings exported to `lib/*-layout.ts` with a test.
- [ ] Any event it can generate has a notification `kind` and a matrix row.
- [ ] Nothing on it is editable anywhere else in the app.
- [ ] No `scrollIntoView`. No horizontal overflow at 390.

## 9. Known debt

| Thing                                        | Status                          |
| -------------------------------------------- | ------------------------------- |
| Org chart as landing screen                  | Replaced by Today               |
| Tool calls as loud as sentences              | Replaced by activity pills      |
| Persona editable in multiple places          | Replaced by one workspace       |
| Eight tabs in a 390px bottom bar             | Replaced by five plus More      |
| Multiple bespoke overlay implementations     | Replaced by one Sheet           |
| Composer hidden by the iOS keyboard          | Resolved                        |
| Notifications limited to push and tab titles | Replaced by durable records     |
| Credentials in EventSource query strings     | Resolved with header-based auth |
