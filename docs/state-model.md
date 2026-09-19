# State model

## Session states

| State | Family | Meaning | Budget clock (outside) |
|---|---|---|---|
| `idle` | initial | Initial state of a new record. `start_session` moves it to `analyzing` before the first save, so `idle` is never persisted. | stopped |
| `analyzing` | active | Agent is inspecting repo and docs to build the work graph. | running |
| `planning` | active | Graph exists; orchestrator is re-evaluating what is executable. Entered after a graph update or a report when nothing is left in flight. | running |
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
not listed throws `INVALID_TRANSITION`. Self-transitions are always allowed;
they change nothing but may update the recorded reason.

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
Everything else goes through one pure evaluation (`evaluate` in
`core/evaluate.ts`) that inspects the graph, budget, and policy:

```
if graph was never submitted
   and budget exhausted (outside)       → resumable   (stop: budget_exhausted)
   otherwise                            → analyzing   (action: plan)
if budget exhausted (outside)
   and units in flight                  → running     (action: wait — finish or checkpoint)
   and validation needed, first attempt → validating  (one wrap-up attempt past budget)
   and executable work remains          → resumable   (stop: budget_exhausted)
   otherwise                            → classify halt (below)
if executable units fit the budget      → running     (action: execute)
if units in flight                      → running     (action: wait)
if validation needed                    → validating  (action: execute validation unit)
if executable units exist but none fit  → resumable   (stop: budget_insufficient)
classify halt:
   no remaining units                   → completed
   any remaining unit gated by decision → waiting_for_human
   otherwise                            → blocked
```

"Validation needed" means completed task units lack a passing validation **and**
no validation unit is `failed` or `blocked`. A stuck validation unit is remaining
work with a `failure:`/`blocker:` root cause, so the session halts as `blocked`
until a human reopens it; the orchestrator never spawns a replacement.

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
  before halting. Past the budget, exactly one wrap-up validation attempt is
  allowed; a retry after a failure is not.
- Analysis is budgeted too: an OUTSIDE session still `analyzing` when the
  budget runs out halts as `resumable`.
- Remaining budget is never a reason to create work. When nothing meaningful is
  executable the session halts and the report states the unused budget as a
  normal outcome.
- `resume_session` may add budget (`addBudgetMinutes`).

## Liveness and interruption

Every mutating call updates `lastActivityAt`. Reads never mutate.

A session in an active state is **stale** when
`now − lastActivityAt > max(staleAfterMinutes, 1.5 × largest in-flight estimate)`
(`staleAfterMinutes` defaults to 60). Views expose `liveness: active | stale | idle`.

Silent time is charged by default. Only the explicit recovery commands treat a
stale gap as an interruption: `pause_session`, `stop_session` and
`resume_session` close the run (`interrupted`) and the budget clock at
`lastActivityAt`, so the gap is not charged. Any other call after a silence
(`next_work`, `report_work`, `request_decision`, `update_work_graph`) is, as far
as the server can tell, the agent carrying on, and the whole gap counts.
Overcharging a dead agent only makes the session stop early; undercharging real
work would break the autonomy bound. To recover a crashed run, start with one of
the recovery commands.

- `pause_session` keeps in-flight claims; resuming from `paused` returns to
  `running` with them.
- `stop_session` releases in-flight units with their checkpoints.
- `resume_session` on a stale active session (or with `takeover: true`)
  releases in-flight units to `pending` with their last checkpoint and
  re-enters `planning` (or `analyzing` if no graph) in a new run labelled with
  the resumed mode.

## Persistence

`SessionRecord` (see `core/model/session.ts`) is the entire aggregate: phase,
budget, units, decisions, runs, dispatch history, event log, handoff notes.
`schemaVersion` guards future migrations. `revision` guards concurrent writers
(see [architecture.md](architecture.md#concurrency-and-durability)).
