# Decision model

A decision is a question that needs human judgment: architecture, product,
scope, security, or anything the agent cannot settle from the repository and
its instructions. The agent **records** decisions. It never answers them.

## Decision

| Field | Notes |
|---|---|
| `id` | `dec-<n>`, sequential per session. Short so a human can say "resolve dec-2". |
| `question` | The question, answerable without reading code. |
| `whyItMatters` | What goes wrong if decided badly or not at all. Required. |
| `category` | `architecture` \| `product` \| `scope` \| `security` \| `external` \| `other`. |
| `options` | Optional `{ id, label, consequences? }[]`. |
| `recommendation` | Optional. The agent's suggestion, displayed as a suggestion. Never applied. |
| `affectedUnitIds` | Units that cannot proceed until this is decided. May be empty (advisory). |
| `status` | `open` \| `resolved` \| `withdrawn`. |
| `raisedAt`, `raisedInMode`, `raisedDuringState` | Provenance. |
| `resolution` | `{ choice, rationale?, decidedBy, decidedAt }` once resolved. |

## Raising (OUTSIDE or DESK)

`request_decision` — allowed in any non-terminal state:

1. Validates referenced units exist and are not `done`/`cancelled`.
2. Adds the decision id to each affected unit's `decisionIds`. If an affected
   unit was `in_progress`, its claim is released and the reported checkpoint is
   kept, so the work can resume exactly where it stopped.
3. Computes **impact**: the affected units plus all transitive dependents that
   are still remaining.
4. Computes **independent work**: ready units outside the impact set.
5. Returns both, plus a directive: continue with independent work if any.

It never blocks, never waits for an answer, and never ends the run by itself.
The run halts as `waiting_for_human` only when evaluation finds that **all**
remaining work is gated and at least one gate is a decision.

## Resolving (human only)

`record_decision` is refused with `DECISION_REQUIRES_HUMAN` when the session is
in OUTSIDE_MODE **and** in an active state (`analyzing`, `planning`, `running`,
`validating`). That is exactly the situation in which no human is present.

It is accepted in DESK_MODE, or in any halted state (the autonomous run has
ended; whoever calls is at the desk). The caller must pass `decidedBy`.

On resolution:

1. `status = resolved`, resolution stored.
2. The decision id is removed from gating (units keep a note:
   `Decision dec-2 resolved: <choice> — <rationale>`), so the executing agent
   sees the human's answer when it picks the unit up.
3. If the session is halted, it is re-classified. Work that became executable
   moves `waiting_for_human` → `resumable`. The session does not restart until
   `resume_session`.

`withdraw: true` marks a decision `withdrawn` (the question no longer applies)
and releases its gates the same way.

The agent cannot withdraw decisions: a withdrawn gate is indistinguishable from
a decided one for scheduling, so withdrawal is a human action.

## Queue order

`get_decisions` sorts open decisions by:

1. **blocking count** — remaining units in the impact set (most first),
2. `raisedAt` (oldest first).

The first item is the decision that unblocks the most work — what a human at
the desk should answer first.

## Why this shape

- **Persistent**: decisions live in the session record, not in a chat message
  that disappears with the agent's context.
- **Scoped**: a decision gates specific units, so everything else continues.
- **Explained**: `whyItMatters` + options + impact make it answerable in
  seconds from DESK_MODE, without re-reading the repository.
- **Enforced**: the "never invent the decision" rule is a server check, not
  just a prompt.
