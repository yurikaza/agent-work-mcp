# Implementation plan (v0.1)

Status: executed for v0.1. Kept as the record of intent.

## Repository state at start

Empty repository (`.gitignore` containing `.env`, one commit). No existing code or
conventions to follow.

## Technology choices

| Choice | Decision | Why |
|---|---|---|
| Language | TypeScript (ESM, Node ≥ 20) | Reference MCP SDK is TypeScript; strict types help keep the state model honest. |
| MCP SDK | `@modelcontextprotocol/server` 2.x | Stable v2 line implementing MCP spec `2026-07-28`. `serveStdio` also serves 2025-era clients. |
| Validation | `zod` v4 | The SDK's schema dialect; also usable by a future CLI without MCP. |
| Tests | `vitest` | Fast, ESM-native. |
| Persistence | JSON file per session, atomic rename, revision check | Local-first, no backend, trivially replaceable behind a port. |
| License | MIT | Default for a small open-source developer tool. |

## MCP conventions applied (spec 2026-07-28)

- MCP has no protocol-level session. State is carried by an explicit, opaque
  `sessionId` handle returned by `start_session` and passed to every other tool.
- Tool names: `snake_case`, ASCII, unique, deterministic order.
- Every tool has a zod `inputSchema` and `outputSchema`; results return
  `structuredContent` plus the serialized JSON as a text block.
- Business-rule failures return `isError: true` with an actionable message, not
  protocol errors.
- Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint: false`) on every tool.
- Server-level `instructions` carry the OUTSIDE_MODE / DESK_MODE behavioral contract.

## Layers

```
src/core       domain model, state machine, work graph, decisions, budget,
               execution policy, orchestrator, handoff, report, ports
src/adapters   persistence (file, memory), project inspection (git + docs)
src/mcp        tool registration only: schema -> orchestrator call -> result
src/cli.ts     stdio entry point
```

`core` imports nothing from `adapters` or `mcp`. `mcp` imports `core` only
through the orchestrator and contract schemas.

## Build order

1. Docs: architecture, state model, work graph, decision model, session lifecycle.
2. Core model: states + transition table, work graph (validation, readiness,
   root causes, impact), decisions, budget accounting.
3. Execution policy (direct vs parallel) as a pure function.
4. Orchestrator use cases + handoff/report builders.
5. Adapters: memory + file repository, project inspector.
6. MCP server (thin) + stdio CLI.
7. Tests: unit (graph, policy, budget, state machine), orchestrator lifecycle
   and decision behavior, file persistence across restart, MCP end-to-end over
   an in-memory transport, stdio smoke test against the built binary.

## Explicitly out of scope for v0.1

- Todoist and GitHub integrations (adapter slots documented only).
- Running agents from the server itself. The host agent (e.g. Claude Code)
  executes work; the server is the control plane and tells it what to do next.
- Multi-user auth, HTTP transport, hosted persistence.

## Done criteria

- Full OUTSIDE_MODE lifecycle (start → plan → execute → decision raised →
  independent work continues → validation → halt → DESK resolve → resume →
  complete) passes end to end through the MCP boundary.
- State survives a process restart (file repository test).
- `npm run build`, `npm run typecheck`, `npm test` all pass.
