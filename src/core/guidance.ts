/**
 * Behavioral contract shown to agents. Kept in core so every adapter (MCP, CLI)
 * tells the agent the same thing.
 */

export const OPERATING_CONTRACT = `agent-work-mcp orchestrates coding-agent work sessions. It is the control plane: you execute, it keeps the session state, work graph, budget, decision queue and handoff.

OUTSIDE_MODE (mode "outside": no human present, bounded autonomy)
- You own the outcome of the session goal until the budget is spent or no meaningful executable work remains.
- Loop: next_work -> do the dispatched units -> report_work -> next_work. A completed unit NEVER ends the session. Only a next_work response with action "stop" ends the run.
- Never ask the user questions and never wait for answers. When human judgment is needed (architecture, product, scope, security, anything you would otherwise guess), call request_decision with the affected units, then continue with independent work.
- Never invent a decision. Never resolve decisions yourself (record_decision is for humans and is refused while an autonomous run is active).
- Never create work to use up budget. Add units only when they serve the goal; units added after the initial plan need a rationale.
- Prefer a smaller verified change over speculative expansion. Completing a unit requires validation evidence.
- Use subagents only for units next_work assigns to executor "subagent". You remain responsible for integration and final validation.
- Leave the repository coherent: finish or checkpoint in-flight units before stopping.

DESK_MODE (mode "desk": human in the loop)
- Start from get_handoff; do not repeat repository discovery. Help the human resolve get_decisions (most blocking first) with record_decision, then resume_session.`;

export const ANALYSIS_GUIDANCE =
  'Analyze before planning: read the listed docs and the relevant code, inspect current work state (uncommitted changes, TODOs, failing tests). ' +
  'Then call update_work_graph with (1) projectContext: what you learned, key files and the test/build commands, so nobody repeats discovery; ' +
  '(2) units: meaningful work toward the goal with dependsOn edges, honest estimateMinutes, acceptance criteria, and touches (paths) for anything that could run in parallel. ' +
  'Record questions that need a human with request_decision and reference them via decisionIds instead of guessing. ' +
  'If there is genuinely nothing meaningful to do, submit an empty unit list: the session will complete without inventing work.';

export const AFTER_REPORT =
  'A finished unit does not end the session. Call next_work now to re-evaluate the graph and continue.';

export function decisionRecordedGuidance(independentReady: number): string {
  return independentReady > 0
    ? `Decision queued for a human. ${independentReady} independent unit(s) are ready: call next_work and keep going. Do not wait for an answer.`
    : 'Decision queued for a human. No independent unit is ready right now; call next_work. The session halts as waiting_for_human only if nothing else can proceed.';
}

export const STOP_GUIDANCE: Record<string, string> = {
  budget_exhausted:
    'Autonomous budget is spent. End the run: summarize from get_handoff. The session is resumable (resume_session with addBudgetMinutes).',
  budget_insufficient:
    'Remaining budget cannot fit any ready unit. End the run and summarize from get_handoff. The session is resumable with more budget.',
  waiting_for_human:
    'All remaining work depends on human decisions. End the run and present the open decisions from get_handoff. Do not answer them yourself.',
  blocked:
    'All remaining work is blocked by blockers or failures that need a human. End the run and present the blocked units from get_handoff.',
  completed: 'All work is done and validated. Present the report from get_session_report.',
  failed: 'The session ended as failed. Present the report from get_session_report.',
  paused: 'The session is paused. Do not continue work until resume_session is called.',
  not_active: 'The session is not running. Inspect get_handoff; resume_session continues it.',
};
