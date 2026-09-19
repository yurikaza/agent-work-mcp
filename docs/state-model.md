# State model

## Session states

| State | Family | Meaning | Budget clock (outside) |
|---|---|---|---|
| `idle` | initial | Session record exists, work has not started. | stopped |
| `analyzing` | active | Agent is inspecting repo and docs to build the work graph. | running |
| `planning` | active | Graph exists; orchestrator is re-evaluating what is executable. Entered after every graph update and every completion. | running |
| `running` | active | At least one unit is claimed and in flight. | running |
| `validating` | active | The session-level validation unit is in flight. | running |
| `waiting_for_human` | halted | No executable work; remaining work is gated by at least one open decision. | stopped |
| `blocked` | halted | No executable work; remaining work is gated by blockers or failures, not decisions. | stopped |
| `paused` | halted | Explicitly paused. In-flight claims are kept. | stopped |
| `resumable` | halted | Run ended (budget exhausted, stopped, interrupted) with work still executable. | stopped |
| `completed` | terminal | Every unit is done or cancelled, task work is validated, nothing failed. | stopped |
| `failed` | terminal | Session was explicitly ended as failed. | stopped |

Families drive behavior:

- **active** — an autonomous (or desk) run is in progress. In OUTSIDE_MODE the
  agent must not record decisions in these states.
- **halted** — nothing is running. A human can inspect, decide, and resume.
- **terminal** — no further transitions.

## Transition table

Enforced by `assertTransition` in `core/model/state-machine.ts`. Any transition
not listed throws `INVALID_TRANSITION`. Self-transitions are no-ops.

| From | To |
|---|---|
| `idle` | `analyzing`, `failed` |
| `analyzing` | `planning`, `waiting_for_human`, `paused`, `resumable`, `failed` |
| `planning` | `running`, `validating`, `waiting_for_human`, `blocked`, `paused`, `resumable`, `completed`, `failed` |
| `running` | `planning`, `validating`, `waiting_for_human`, `blocked`, `paused`, `resumable`, `completed`, `failed` |
| `validating` | `planning`, `running`, `waiting_for_human`, `blocked`, `paused`, `resumable`, `completed`, `failed` |
| `waiting_for_human` | `analyzing`, `planning`, `blocked`, `resumable`, `completed`, `failed` |
| `blocked` | `analyzing`, `planning`, `waiting_for_human`, `resumable`, `completed`, `failed` |
| `paused` | `analyzing`, `planning`, `running`, `validating`, `waiting_for_human`, `blocked`, `resumable`, `completed`, `failed` |
| `resumable` | `analyzing`, `planning`, `waiting_for_human`, `blocked`, `completed`, `failed` |
| `completed` | — |
| `failed` | — |

Halted → halted moves (e.g. `waiting_for_human` → `resumable`) happen when a
human records a decision that makes work executable again. The session does
**not** restart itself; only `resume_session` re-enters an active state.

## How the next state is chosen

Explicit commands (`start`, `pause`, `resume`, `stop`) move the state directly.
Everything else goes through one pure evaluation (`evaluate` in the
orchestrator) that inspects the graph, budget, and policy:

```
if graph was never submitted            → analyzing   (action: plan)
if budget exhausted (outside)
   and units in flight                  → running     (action: wait — finish or checkpoint)
   and unvalidated completed task work  → validating  (validation is always allowed as wrap-up)
   and executable work remains          → resumable   (stop: budget_exhausted)
   otherwise                            → classify halt (below)
if executable units fit the budget      → running     (action: execute)
if units in flight                      → running     (action: wait)
if completed task work is unvalidated   → validating  (action: execute validation unit)
if executable units exist but none fit  → resumable   (stop: budget_insufficient)
classify halt:
   no remaining units                   → completed
   any remaining unit gated by decision → waiting_for_human
   otherwise                            → blocked
```

"Remaining" means units with status `pending`, `blocked`, or `failed`.

## Unit states

| Status | Meaning |
|---|---|
| `pending` | Not started. May or may not be executable (see readiness). |
| `in_progress` | Claimed by `next_work`. Has a claim (`executor`, `isolation`, `at`). |
| `done` | Completed with passing validation evidence. |
| `failed` | Attempts exhausted. Dependents are blocked until a human reopens it. |
| `blocked` | Agent reported an external blocker (environment, access, outage). |
| `cancelled` | Removed from scope with a reason. Dependents need re-planning. |

Readiness is derived, never stored: `ready`, `waiting_on_dependencies`,
`waiting_on_decision`, `blocked`, `in_progress`, `done`, `failed`, `cancelled`.

## Budget

- `totalMinutes` is the session's autonomy, not a per-task limit. A unit
  estimated at 4 hours may take 4 hours of a 5-hour budget.
- Consumption is wall-clock time spent in active states **in OUTSIDE_MODE**.
  Stored as `consumedMs` plus `activeSince` (ISO timestamp or `null`), so it is
  exact across restarts.
- A task unit is claimable when `estimate ≤ (remaining − reserve) × (1 + tolerance)`
  or it has no estimate and `remaining − reserve ≥ minStartMinutes`.
  Defaults: `reserve = 10`, `tolerance = 0.25`, `minStartMinutes = 5`.
- The reserve exists so the session can always run integration validation
  before halting. Validation is never refused for budget.
- Remaining budget is never a reason to create work. When nothing meaningful is
  executable the session halts and the report states the unused budget as a
  normal outcome.
- `resume_session` may add budget (`addBudgetMinutes`).

## Liveness and interruption

Every mutating call updates `lastActivityAt`. Reads never mutate.

A session in an active state is **stale** when
`now − lastActivityAt > max(staleAfterMinutes, 1.5 × largest in-flight estimate)`
(`staleAfterMinutes` defaults to 60). Views expose `liveness: active | stale | idle`.

`resume_session` on a stale active session (or with `takeover: true`) recovers:

1. budget consumption is closed at `lastActivityAt`, not at now,
2. in-flight units return to `pending` with their last checkpoint preserved,
3. the run is recorded as ended with `interrupted`,
4. the session re-enters `planning` (or `analyzing` if no graph).

## Persistence

`SessionRecord` (see `core/model/session.ts`) is the entire aggregate: phase,
budget, units, decisions, runs, dispatch history, event log, handoff notes.
`schemaVersion` guards future migrations. `revision` guards concurrent writers.
