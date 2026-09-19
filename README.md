# agent-work-mcp

An MCP server for agent work orchestration. It gives a coding agent a persistent
**work session** with a **budget**, a **dependency graph** of work, a **human
decision queue**, required **validation**, and an exact **handoff**, so the
agent can work autonomously for hours and hand back cleanly.

Two modes:

- **OUTSIDE_MODE**: bounded autonomous execution. You are away. The agent owns
  the phase goal until the budget is spent or no meaningful executable work
  remains. It never blocks on questions: it records them and continues with
  everything that does not depend on the answer.
- **DESK_MODE**: human-in-the-loop execution. You are back. Start from the
  handoff, answer the queued decisions (most blocking first), resume.

The server is a control plane. It does not run models or edit code. Your agent
(Claude Code, or any MCP client) does the work. Nothing in the core depends on
one model or provider.

> **Status: v0.1.** The core lifecycle is implemented and tested end to end
> through the MCP boundary and over stdio. It is not published to npm yet.
> GitHub and Todoist integrations are intentionally not part of v0.1.

## What it enforces

| Rule | How |
|---|---|
| One finished task never ends the run | `report_work` never halts a session and tells the agent to call `next_work`; only `next_work` → `stop` ends a run. |
| The budget is for the session, not per task | A 4-hour unit may use 4 hours of a 5-hour budget; a 20-minute unit takes 20 minutes and the next work is picked. |
| Never invent work to use up budget | Units added after the initial plan need a rationale and are listed in the report. Unused budget is reported as a normal outcome. |
| Never invent decisions | `record_decision`, removing a decision gate, and cancelling decision-gated work are refused while an OUTSIDE run is active. |
| Decisions don't stop independent work | A decision gates only its affected units and their dependents. |
| Parallelism must be earned | Subagents only for isolated units (disjoint `touches`/workstreams) whose elapsed-time savings beat agent + integration overhead. |
| Smaller verified change over speculation | `completed` needs validation evidence; a session-level integration validation runs before halting with unvalidated work (a failed validation halts as `blocked` for a human). |
| Survive interruption | Session state is written as immutable revision files with an atomic compare-and-swap that holds across processes. Recovering a crashed run with `pause_session`, `stop_session` or `resume_session` doesn't charge the silent gap, and `resume_session` recovers in-flight units from their checkpoints. |

## Quick start (Claude Code)

```bash
git clone https://github.com/yurikaza/agent-work-mcp.git
```

```bash
cd agent-work-mcp && npm install && npm run build
```

Register it in the project you want to work on (run inside that project):

```bash
claude mcp add agent-work --scope project -- node /absolute/path/to/agent-work-mcp/dist/cli.js
```

Session state is stored in `<project root>/.agent-work/`, which ignores itself in git. The project root is the
server's working directory unless `AGENT_WORK_PROJECT_ROOT` is set (or `projectRoot` is passed to `start_session`).

Then, before you leave:

> Start an agent-work OUTSIDE session: goal "finish the invitations feature
> (phase 2)", budget 180 minutes. Follow next_work until it says stop.

When you are back:

> Show me the agent-work handoff for the last session and walk me through the
> open decisions.

## The OUTSIDE loop

```
start_session(mode: "outside", goal, budgetMinutes)       → analyzing
update_work_graph(units, projectContext)                   → planning
loop
  next_work  → execute | wait | stop
  … do the unit (or spawn subagents for parallel units) …
  report_work(unitId, "completed", validation evidence)    → planning
  request_decision(...) whenever a human must decide; keep going
until next_work returns action "stop"
```

Stops: `completed`, `waiting_for_human`, `blocked`, `budget_exhausted`,
`budget_insufficient`. Everything except `completed` is resumable.

## Tools

`start_session`, `list_sessions`, `get_session`, `get_phase`,
`pause_session`, `resume_session`, `stop_session`, `get_work_graph`,
`update_work_graph`, `next_work`, `report_work`, `request_decision`,
`get_decisions`, `record_decision`, `get_handoff`, `get_session_report`.

Details: [docs/mcp-tools.md](docs/mcp-tools.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_WORK_PROJECT_ROOT` | server working directory | Project root for new sessions. |
| `AGENT_WORK_STATE_DIR` | `<project root>/.agent-work` | Where sessions are stored. |

Policy defaults (parallelism thresholds, budget reserve, retry limits, staleness)
live in `src/core/policy/policy.ts` and can be overridden when constructing the
`Orchestrator` programmatically.

## Architecture

```
src/core      orchestration, state machine, work graph, decisions, budget,
              execution policy, handoff, report  (no MCP, no I/O)
src/adapters  file/memory persistence, git + docs project inspector
src/mcp       thin tool layer over the orchestrator
src/cli.ts    stdio entry point
```

- [Architecture](docs/architecture.md)
- [State model](docs/state-model.md)
- [Work graph model](docs/work-graph.md)
- [Decision model](docs/decision-model.md)
- [Session lifecycle](docs/session-lifecycle.md)
- [MCP tools](docs/mcp-tools.md)
- [Implementation plan](docs/implementation-plan.md)

The core is usable without MCP:

```ts
import { Orchestrator, FileSessionRepository } from 'agent-work-mcp';

const o = new Orchestrator({ repository: new FileSessionRepository('.agent-work') });
const { session } = await o.startSession({ mode: 'outside', goal: 'Ship phase 1', budgetMinutes: 120 });
```

## Development

```bash
npm test
```

```bash
npm run typecheck && npm run build
```

Tests cover the state machine, work graph, execution policy, budget, the full
OUTSIDE and DESK lifecycles, decision behavior, interruption and resume,
persistence across a simulated restart and concurrent writers, lifecycle
invariants under random operation sequences, the MCP surface over an in-memory
transport, and the built binary over stdio.

## Roadmap

- Prompts for Claude Code (`/outside`, `/desk`) that kick off each mode.
- Work sources: GitHub issues and Todoist tasks mapped into the work graph.
- An `AgentExecutor` port so the server can dispatch to headless agents directly.
- Streamable HTTP transport for remote use.

## License

MIT
