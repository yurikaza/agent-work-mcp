# MCP tools

16 high-level tools. Names are `snake_case`; every tool declares an
`inputSchema`, an `outputSchema`, and annotations (`openWorldHint: false` on
all; `readOnlyHint: true` on the seven read tools). Results carry
`structuredContent` plus a text block (JSON, or Markdown for `get_handoff`,
`get_session_report` and `stop_session`). Rule violations return `isError: true` with `CODE: message`, so the
model can read and correct them.

MCP `2026-07-28` has no protocol-level session. Every tool except
`start_session` and `list_sessions` takes the explicit `sessionId` handle.
Sessions do not expire; they end when completed or stopped as failed.

The server's `instructions` field carries the operating contract for both
modes (see `src/core/guidance.ts`).

## Lifecycle

| Tool | Purpose | Key inputs |
|---|---|---|
| `start_session` | Create a session and start analysis. Returns handle, repo snapshot, docs to read. | `mode`, `goal`, `budgetMinutes` (outside), `exitCriteria`, `constraints`, `projectRoot` |
| `list_sessions` | Find sessions (newest first) with state, liveness, budget, open decisions. | `projectRoot`, `includeTerminal` |
| `get_session` | Inspect state, budget, counts, in-flight units, runs. | `sessionId` |
| `get_phase` | Phase goal, exit criteria, constraints, progress, recorded project context. | `sessionId` |
| `pause_session` | Pause an active session; stops the budget clock, keeps claims. | `sessionId`, `reason`, `notes` |
| `resume_session` | Resume from the handoff; optional mode switch and budget top-up; recovers interrupted runs. | `sessionId`, `mode`, `addBudgetMinutes`, `takeover` |
| `stop_session` | End the run; release in-flight units; classify; return the report. | `sessionId`, `reason`, `notes`, `markFailed` |

## Work graph and execution

| Tool | Purpose | Key inputs |
|---|---|---|
| `get_work_graph` | Units with readiness and root causes, plus edges. | `sessionId`, `filter` |
| `update_work_graph` | Upsert units, cancel, reopen, record project context. All-or-nothing. | `units[]`, `cancel[]`, `reopen[]`, `projectContext` |
| `next_work` | Evaluate and claim the next work: `execute` / `wait` / `plan` / `stop`. | `sessionId` |
| `report_work` | Report a claimed unit: `progress`, `completed` (+ evidence), `failed`, `blocked`, `released`. | `unitId`, `outcome`, `summary`, `validation`, `blocker`, `checkpoint`, `artifacts` |

## Decisions

| Tool | Purpose | Key inputs |
|---|---|---|
| `request_decision` | Queue a question for a human; gate affected units; get independent work back. | `question`, `whyItMatters`, `category`, `options`, `recommendation`, `affectedUnitIds`, `checkpoint` |
| `get_decisions` | Queue, most blocking first; `canRecordDecisions` says whether a human may answer now. | `status` |
| `record_decision` | Human answer (or withdrawal). Refused during an active OUTSIDE run. | `decisionId`, `choice`, `rationale`, `decidedBy`, `withdraw` |

## Handoff and report

| Tool | Purpose |
|---|---|
| `get_handoff` | Where to pick up: decisions by impact, in-flight checkpoints, ready/blocked/completed units, project context, live repository state, ordered next actions. Markdown text + structured data. |
| `get_session_report` | Outcome, budget use and why any was unused, validation evidence, decisions, parallel dispatch rationale, mid-session scope, next steps. |

## Error codes

| Code | Meaning |
|---|---|
| `NOT_FOUND` | Unknown session, unit or decision. |
| `INVALID_INPUT` | Semantically invalid input (e.g. `blocked` without `blocker`). |
| `INVALID_TRANSITION` | State machine rejected the change (indicates a bug; please report). |
| `SESSION_TERMINAL` | Session is completed or failed. |
| `SESSION_ACTIVE` | Resume refused: the session looks alive. Use `takeover: true` if it is not. |
| `SESSION_NOT_ACTIVE` | Pause refused: nothing is running. |
| `SESSION_CONFLICT` | Another session is actively running on the same project. |
| `CONFLICT` | Another writer changed the session concurrently. Retry. |
| `GRAPH_INVALID` | Bad id, unknown reference, self-dependency or cycle. Nothing was applied. |
| `UNIT_NOT_CLAIMED` | Only `in_progress` units can be reported. |
| `UNIT_IMMUTABLE` | Done units, validation units, or cancelled units via upsert. |
| `VALIDATION_REQUIRED` | Completion without evidence. |
| `RATIONALE_REQUIRED` | Unit added after the initial plan without a rationale. |
| `DECISION_REQUIRES_HUMAN` | `record_decision`, or cancelling decision-gated work, during an active OUTSIDE run. |
| `DECISION_NOT_OPEN` | Decision already resolved or withdrawn. |
| `BUDGET_REQUIRED` | OUTSIDE session without `budgetMinutes`. |
| `BUDGET_EXHAUSTED` | Resume in OUTSIDE mode with no budget left. |

## Compatibility

Served with `serveStdio` from `@modelcontextprotocol/server` 2.x: clients on the
`2026-07-28` revision and 2025-era clients (`initialize` handshake) are both
supported on the same binary.
