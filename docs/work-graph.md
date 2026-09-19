# Work graph model

The work graph is a DAG of **work units**. The agent builds it after analyzing
the repository (`update_work_graph`) and may revise it at any time. The server
validates it, derives what is executable, and schedules.

## Work unit

| Field | Type | Notes |
|---|---|---|
| `id` | string | Agent-chosen slug, `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Stable; used in edges. |
| `title` | string | One line. |
| `description` | string? | What to do, where. |
| `kind` | `task` \| `investigation` \| `validation` | `validation` is reserved for units the orchestrator creates. |
| `dependsOn` | string[] | Unit ids that must be `done` first. |
| `decisionIds` | string[] | Decisions that must be resolved first. |
| `estimateMinutes` | number? | Honest estimate. Used for budget fit and parallelism. Unknown is allowed. |
| `priority` | `high` \| `normal` \| `low` | Tie-breaker after unblocking power. |
| `acceptance` | string[] | What "done" means. Evidence is required at completion. |
| `workstream` | string? | Units in the same workstream never run in parallel. |
| `touches` | string[] | Paths/areas the unit changes. Required for parallel dispatch. |
| `parallelSafe` | boolean | Default `true`. `false` forces direct execution. |
| `rationale` | string? | Why this unit exists. **Required** for units added after the initial plan. |

Server-managed fields: `status`, `attempts`, `claim`, `checkpoint`, `blocker`,
`result`, `notes`, `addedLate`, `validates`, `validatedBy`, `cancelReason`.

## Validation on update

`update_work_graph` rejects the whole update (nothing is applied) if:

- an id is malformed or duplicated in the request,
- a `dependsOn` target does not exist after the update,
- a `decisionIds` entry names an unknown decision,
- the result has a cycle (the error names the cycle path),
- it modifies a `done` unit or cancels one,
- it removes an **open** decision id from a unit's `decisionIds` (only
  `record_decision` releases a decision),
- it cancels a unit that waits on an open decision while an OUTSIDE run is
  active (`DECISION_REQUIRES_HUMAN`),
- it declares `kind: validation`,
- a unit added after the initial plan has no `rationale`.

Upserting an existing non-terminal unit merges fields; a changed `dependsOn` is
recorded in the unit's notes. Status is never set through the graph; it changes
only through `next_work`, `report_work`, `cancel`, and `reopen`.

## Derived readiness

For a unit with status `pending`:

- `waiting_on_decision` — one of its own `decisionIds` is open,
- `waiting_on_dependencies` — a dependency is not `done`,
- `ready` — otherwise.

Other statuses map 1:1 (`in_progress`, `done`, `failed`, `blocked`, `cancelled`).

### Root causes

For any remaining unit that is not ready, the graph walks dependencies to find
**why** it cannot run:

| Root cause | Source |
|---|---|
| `decision:<id>` | An open decision on the unit or on any unfinished ancestor. |
| `blocker:<unitId>` | A `blocked` ancestor (or itself). |
| `failure:<unitId>` | A `failed` ancestor (or itself). |
| `cancelled:<unitId>` | A dependency was cancelled; needs re-planning. |

Root causes drive session halt classification (`waiting_for_human` vs
`blocked`), decision impact, and the handoff's "blocked" section.

## Scheduling order

Ready units are ordered by:

1. **Unblocking power** — number of transitive dependents (critical path first),
2. `priority`,
3. insertion order.

## Direct vs parallel dispatch

`planExecution` (`core/policy/execution-policy.ts`) is a pure function. It
returns a strategy, assignments, and the reasons for the choice.

A set of ready units is dispatched in parallel only if **all** hold:

- mode is `outside` (DESK_MODE is sequential and human-paced),
- every unit is `parallelSafe`, has an `estimateMinutes`, and declares `touches`,
- no two units (or any in-flight unit) share a workstream or overlapping
  `touches` (path-prefix overlap) — isolation must be provable,
- `savings − cost ≥ minSavingsMinutes`, where
  `savings = Σestimates − max(estimate)` and
  `cost = (n − 1) × (agentOverheadMinutes + integrationMinutes)`.

Defaults: `maxParallel = 3`, `agentOverheadMinutes = 10`,
`integrationMinutes = 5`, `minSavingsMinutes = 30`. Two 60-minute isolated
units run in parallel (45 ≥ 30); two 20-minute units do not (5 < 30).

Otherwise the top unit is dispatched **directly** to the main agent.

In a parallel dispatch, the largest unit goes to the `main` agent and the rest
to `subagent` executors with `isolation: worktree`. The main agent integrates
subagent output, reports each unit, and owns final validation.

When units are already in flight, one additional unit may be dispatched to the
main agent if the main agent holds no unit, fewer than `maxParallel` units are
in flight, and the unit is isolated from everything in flight; otherwise the
answer is `wait`. The main agent never holds more than one unit.

The policy's inputs are the ready units, the in-flight units, the mode and the
policy constants. Remaining budget is not an input: more budget never produces
more parallelism. Budget only filters which units may start at all.

## Validation units

When no other executable work remains, nothing is in flight, and `done` task
units exist that no passing validation covers, the orchestrator adds one
`validation` unit (`validate-<n>`) that depends on them, carries the phase exit
criteria plus the covered units' acceptance criteria, and dispatches it. The
session is `validating` while it runs.

- Pass → covered units get `validatedBy`.
- Fail → the unit returns to `pending` with the failure noted. Any fix units the
  agent adds run first (validation is always scheduled last), then validation
  re-runs and extends its coverage. After `maxAttempts` (default 3) the unit
  fails and the session halts as `blocked`.
- Blocked or failed → no replacement validation unit is ever created. The
  session halts as `blocked`; a human fixes the cause and reopens the unit.
- Validation units cannot be gated by decisions, cancelled, or edited.

`investigation` units produce knowledge, not code, and do not require
integration validation.

## Completing a unit

`report_work` with `outcome: completed` must include
`validation: { passed: true, checks: [...] }` with at least one check, or
`notApplicableReason`. `passed: false` counts as a failed attempt. This is the
"smaller verified change" rule in code form: nothing becomes `done` on
assertion alone.
