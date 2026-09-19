# Architecture

`agent-work-mcp` is a **control plane** for agent work. It does not write code
or run models. A host coding agent (Claude Code today, anything that speaks MCP
tomorrow) is the **execution plane**: it reads the repository, edits files, runs
tests, and spawns its own subagents. The server owns what the agent cannot keep
reliably in its context window:

- what the session is trying to achieve and how much autonomy it has left,
- the dependency graph of work and what is executable right now,
- which questions need a human and which work they block,
- whether completed work was validated,
- an exact, persistent handoff when autonomy ends or the process dies.

## Two modes

| | OUTSIDE_MODE (`outside`) | DESK_MODE (`desk`) |
|---|---|---|
| Who is present | Nobody. Agent runs alone. | A human is at the desk. |
| Budget | Total autonomous wall-clock budget, enforced. | Not consumed. |
| Human decisions | Recorded in the queue, never answered by the agent. | Resolved by the human (`record_decision`). |
| Execution | Continuous: after each completion, re-evaluate and continue. | Sequential, one unit at a time, human in the loop. |
| Ends when | Budget exhausted, or no meaningful executable work remains. | Human decides. |

OUTSIDE_MODE is the primary feature. DESK_MODE exists to make the output of an
OUTSIDE run cheap to act on: the handoff is designed so the desk agent does not
repeat repository discovery.

## Core concepts

| Concept | Where | Summary |
|---|---|---|
| Work Session | `core/model/session.ts` | Aggregate root. One campaign toward one phase goal in one project. Persisted as a unit. |
| Session State | `core/model/state-machine.ts` | 11 states, explicit transition table. See [state-model.md](state-model.md). |
| Work Graph | `core/model/work-graph.ts` | Units + `dependsOn` edges + decision gates. Readiness and root causes are derived, never stored. See [work-graph.md](work-graph.md). |
| Task / Work Unit | `core/model/work-graph.ts` | Smallest schedulable piece of work, with acceptance criteria and optional estimate. |
| Autonomous Budget | `core/model/budget.ts` | Wall-clock minutes of autonomy for the whole session, not per task. |
| Human Decision Queue | `core/model/decisions.ts` | Persistent questions that block specific units. See [decision-model.md](decision-model.md). |
| Agent / Subagent execution | `core/policy/execution-policy.ts` | Decides direct vs parallel dispatch and says why. The host agent spawns subagents. |
| Validation | orchestrator + graph | Per-unit evidence is required to complete a unit; a session-level validation unit integrates before the run halts. |
| Handoff State | `core/handoff.ts` | Derived from persisted state; tells the next operator exactly where to pick up. |
| Final session report | `core/report.ts` | Outcome, budget use, validation, decisions, parallelism, next steps. |

## Layering

```
┌──────────────────────────────────────────────────────────────┐
│ mcp/            thin: zod schemas → Orchestrator → result     │
│   server.ts     tool registration, error mapping, instructions│
├──────────────────────────────────────────────────────────────┤
│ core/           no I/O, no MCP transport, no network          │
│   orchestrator  use cases (start, next, report, decide, …)    │
│   model/        session, state machine, graph, decisions,     │
│                 budget                                        │
│   policy/       execution policy (direct vs parallel)         │
│   handoff, report, guidance, contracts (zod), ports           │
├──────────────────────────────────────────────────────────────┤
│ adapters/       implement core ports                          │
│   persistence/  FileSessionRepository, MemorySessionRepository│
│   project/      GitDocsProjectInspector (git status + docs)   │
│   (future)      github/, todoist/ — not in v0.1               │
└──────────────────────────────────────────────────────────────┘
```

Rules:

- `core` never imports from `adapters` or `mcp`.
- `core` talks to the outside world through ports (`core/ports.ts`):
  `SessionRepository`, `Clock`, `IdGenerator`, `ProjectInspector`.
- `core/contracts.ts` defines command and view schemas with zod. The MCP layer
  reuses them as `inputSchema` / `outputSchema`; a future CLI can reuse them for
  argument validation. Zod is a validation library, not a transport detail.
- The MCP layer contains no orchestration decisions. If a behavior matters, it
  is in `core` and tested there.

## Control flow (OUTSIDE_MODE)

```
host agent                          agent-work-mcp (core)
──────────                          ─────────────────────
start_session(goal, budget) ──────► create session, snapshot repo  → analyzing
read docs/code
update_work_graph(units, ctx) ────► validate graph (ids, refs, cycles) → planning
loop:
  next_work ──────────────────────► evaluate graph + budget + policy
                               ◄─── execute {direct|parallel, units}  → running
                                    | wait (units in flight)
                                    | stop {reason, handoff}           → halted state
  do the work (maybe via subagents)
  report_work(unit, completed, validation) ► record, re-evaluate       → planning
  request_decision(question, affected) ───► queue, gate units, return
                                            independent work (never blocks)
```

The server never pushes; the agent pulls. The server holds no per-connection
state between calls (everything lives in the session store), which is also what
the MCP `2026-07-28` spec expects: no protocol-level session, explicit handles.

## Concurrency and durability

- One JSON document per session (`<stateDir>/sessions/<id>.json`), written to a
  temp file and renamed (atomic on POSIX).
- Every document carries a `revision`. `save` fails with `CONFLICT` if the stored
  revision moved, so two processes cannot silently overwrite each other.
- Within one process, calls for the same session are serialized by a per-session
  lock in the orchestrator.
- The default state directory is `<project root>/.agent-work/` (project root =
  `AGENT_WORK_PROJECT_ROOT` or the server's working directory). It writes its own
  `.gitignore` (`*`) so it never dirties the host repository. Override with
  `AGENT_WORK_STATE_DIR`.

## Extension points

| Want | Do |
|---|---|
| SQLite / hosted store | Implement `SessionRepository`. |
| CLI | Construct `Orchestrator` directly; reuse `core/contracts.ts`. |
| Other protocol | Same as CLI. MCP is one adapter. |
| GitHub issues / Todoist as work sources | New adapter that maps external items into `update_work_graph` commands. Kept out of v0.1 until core behavior is proven. |
| Server-driven agent execution | A future `AgentExecutor` port (e.g. Claude Agent SDK, `claude -p`) that the orchestrator can dispatch to. v0.1 relies on the host agent. |

## MCP surface

See [mcp-tools.md](mcp-tools.md).
