# Session lifecycle

## OUTSIDE_MODE run

```
start_session(mode: outside, goal, budgetMinutes)
   │  idle → analyzing; returns sessionId, repo snapshot, operating contract
   ▼
analyze repository and docs (agent)
   │
update_work_graph(units, projectContext)
   │  analyzing → planning
   ▼
┌─► next_work ─────────────────────────────────────────────────────────┐
│     action: execute  → do the units (direct or parallel)             │
│     action: wait     → finish in-flight units                        │
│     action: stop     → run is over; show the handoff, end the turn   │
│                                                                      │
│   report_work(unitId, completed|failed|blocked|progress, …)          │
│     → re-evaluated; state back to planning when nothing is in flight │
│                                                                      │
│   request_decision(question, whyItMatters, affectedUnitIds)          │
│     → gated units wait, independent work continues                   │
│                                                                      │
│   update_work_graph(…) whenever reality differs from the plan        │
└──────────────────────────────────────────────── (loop until stop) ───┘
```

Rules the server enforces or states in every relevant response:

- A completed unit never ends the run. `report_work` always answers with
  "call `next_work`".
- A decision never ends the run while independent work exists.
- The run ends only when `next_work` returns `stop`:
  - `budget_exhausted` — budget spent; executable work remains → `resumable`,
  - `budget_insufficient` — remaining budget cannot fit any ready unit → `resumable`,
  - `waiting_for_human` — all remaining work is gated, at least one gate is a decision,
  - `blocked` — all remaining work is gated by blockers or failures,
  - `completed` — everything done and validated,
  - `paused` / `stopped` / `not_active` — session not in an active state.
- Before any halt with completed task work, a validation unit runs first.
- Remaining budget is never a reason to add work. Units added after the initial
  plan must carry a rationale and are listed in the report as mid-session scope.

## DESK_MODE

DESK_MODE starts from the handoff, not from discovery.

```
list_sessions                → find the session
get_handoff(sessionId)       → state, why it stopped, decisions by impact,
                               in-flight checkpoints, ready next units,
                               blocked units with root causes, repo state,
                               project context the agent already gathered
get_decisions                → answer the top one first
record_decision(…)           → gates released; halted session re-classified
resume_session(mode: desk)   → continue with the human in the loop
  or
resume_session(mode: outside, addBudgetMinutes)  → hand back to autonomy
```

A desk session can also be started directly: `start_session(mode: desk, …)`.
Budget is not consumed in DESK_MODE and dispatch is always direct (one unit).

## Pause, resume, stop

| Command | From | Effect |
|---|---|---|
| `pause_session` | active | → `paused`. Budget clock stops. In-flight claims kept. Notes stored. |
| `resume_session` | halted (not terminal), or stale/`takeover` active | Optional mode switch and budget top-up. Recovers interrupted in-flight units. → `planning` (or `analyzing` if no graph; or back to `running` from `paused` with claims intact). |
| `stop_session` | any non-terminal | Ends the current run. In-flight units released with checkpoints. Classified like a halt (`resumable` if work remains executable). `markFailed: true` → `failed` (terminal). Returns the report. |

## Handoff

`get_handoff` is derived from persisted state, so it exists even after a crash.
It contains:

- state, mode, why the run stopped,
- phase goal and exit criteria,
- project context recorded during analysis (summary, key files, commands),
- budget used / remaining,
- open decisions with impact, most blocking first,
- in-flight units with their latest checkpoint,
- ready units (what to do next),
- blocked/failed units with root causes,
- completed units with summaries,
- repository snapshot (branch, head, uncommitted files) at handoff time,
- handoff notes from `pause_session` / `stop_session`,
- ordered next actions for the human,
- a Markdown rendering of all of the above.

## Final report

`get_session_report` summarizes a session at any time and is returned by
`stop_session`:

- outcome and state reason,
- budget total / used / unused, with the reason budget went unused,
- runs (mode, start, end, end reason),
- units by status; completed work with validation evidence,
- failed and blocked work,
- decisions raised / resolved / open,
- dispatches: how many were parallel and why,
- validation runs and results,
- scope added mid-session (with rationale),
- next steps.
