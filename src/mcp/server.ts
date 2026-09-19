/**
 * MCP adapter. Deliberately thin: each tool is schema -> orchestrator call ->
 * result. No orchestration decisions live here.
 */
import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import * as c from '../core/contracts.js';
import { DomainError } from '../core/errors.js';
import { OPERATING_CONTRACT } from '../core/guidance.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { VERSION } from '../version.js';

type AnyObject = z.ZodObject<z.ZodRawShape>;

interface ToolSpec<I extends AnyObject, O extends AnyObject> {
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
  /** Render the text block. Default: the structured result as JSON. */
  text?: (result: z.infer<O>) => string;
  run: (args: z.infer<I>) => Promise<z.infer<O>>;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function createMcpServer(orchestrator: Orchestrator): McpServer {
  const server = new McpServer(
    { name: 'agent-work-mcp', version: VERSION, title: 'Agent Work' },
    { instructions: OPERATING_CONTRACT },
  );

  const tool = <I extends AnyObject, O extends AnyObject>(name: string, spec: ToolSpec<I, O>) => {
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        outputSchema: spec.output,
        annotations: { title: spec.title, ...spec.annotations },
      },
      (async (args: z.infer<I>): Promise<CallToolResult> => {
        try {
          const result = await spec.run(args);
          // Round-trip drops undefined fields so the result matches the JSON output schema.
          const structured = JSON.parse(JSON.stringify(result)) as z.infer<O>;
          const text = spec.text ? spec.text(structured) : JSON.stringify(structured, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: structured as Record<string, unknown> };
        } catch (e) {
          if (e instanceof DomainError) {
            return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}` }] };
          }
          throw e;
        }
      }) as never,
    );
  };

  // ─── session lifecycle ────────────────────────────────────────────────────

  tool('start_session', {
    title: 'Start work session',
    description:
      'Start a work session for a project goal. mode "outside" = bounded autonomous run (no human; requires budgetMinutes, ' +
      'the total wall-clock autonomy for the whole session, not per task). mode "desk" = human in the loop. ' +
      'Returns a sessionId handle (pass it to every other tool), a repository snapshot and analysis instructions. ' +
      'Next: analyze the project, then update_work_graph.',
    input: c.StartSessionInput,
    output: c.StartSessionResult,
    annotations: WRITE,
    run: (a) => orchestrator.startSession(a),
  });

  tool('list_sessions', {
    title: 'List work sessions',
    description: 'List recorded sessions (newest first) with state, budget and open decision counts. Use to find a session to inspect or resume.',
    input: c.ListSessionsInput,
    output: c.ListSessionsResult,
    annotations: READ,
    run: (a) => orchestrator.listSessions(a),
  });

  tool('get_session', {
    title: 'Inspect session',
    description: 'Current state, mode, budget, unit counts, in-flight units and run history of one session.',
    input: c.SessionIdInput,
    output: c.SessionResult,
    annotations: READ,
    run: (a) => orchestrator.getSession(a.sessionId),
  });

  tool('get_phase', {
    title: 'Inspect phase',
    description: 'The phase goal, exit criteria and constraints this session owns, progress toward it, and the project context recorded during analysis.',
    input: c.SessionIdInput,
    output: c.PhaseResult,
    annotations: READ,
    run: (a) => orchestrator.getPhase(a.sessionId),
  });

  tool('pause_session', {
    title: 'Pause session',
    description: 'Pause an active session. Stops the budget clock and keeps in-flight claims. Optional handoff notes.',
    input: c.PauseSessionInput,
    output: c.SessionResult,
    annotations: WRITE,
    run: (a) => orchestrator.pauseSession(a),
  });

  tool('resume_session', {
    title: 'Resume session',
    description:
      'Resume a paused, halted or interrupted session from its handoff. Optionally switch mode (desk/outside) and add budget. ' +
      'Recovers in-flight units of an interrupted run (they return to pending with their checkpoints). Returns the handoff.',
    input: c.ResumeSessionInput,
    output: c.ResumeSessionResult,
    annotations: WRITE,
    run: (a) => orchestrator.resumeSession(a),
  });

  tool('stop_session', {
    title: 'Stop session',
    description:
      'End the current run. In-flight units are released with their checkpoints and the session is classified ' +
      '(resumable, waiting_for_human, blocked or completed). markFailed: true ends it permanently as failed. Returns the final report.',
    input: c.StopSessionInput,
    output: c.StopSessionResult,
    annotations: { ...WRITE, destructiveHint: true },
    text: (r) => r.report.markdown,
    run: (a) => orchestrator.stopSession(a),
  });

  // ─── work graph & execution ───────────────────────────────────────────────

  tool('get_work_graph', {
    title: 'Inspect work graph',
    description:
      'Units with status, derived readiness and root causes (decision:, blocker:, failure:, cancelled:), plus dependency edges. ' +
      'Filter: all | remaining | ready | in_progress | done.',
    input: c.GetWorkGraphInput,
    output: c.WorkGraphResult,
    annotations: READ,
    run: (a) => orchestrator.getWorkGraph(a),
  });

  tool('update_work_graph', {
    title: 'Update work graph',
    description:
      'Add or update units (upsert by id), cancel or reopen units, and record project context (summary, key files, commands). ' +
      'The first call submits the initial plan. Rejected as a whole if ids, references or dependencies are invalid or cyclic. ' +
      'Units added after the initial plan need a rationale. Never add work only to use remaining budget.',
    input: c.UpdateWorkGraphInput,
    output: c.UpdateWorkGraphResult,
    annotations: WRITE,
    run: (a) => orchestrator.updateWorkGraph(a),
  });

  tool('next_work', {
    title: 'Next work',
    description:
      'Re-evaluate the graph, budget and policy and claim the next work. action "execute" = do the dispatched units ' +
      '(direct, or parallel with subagents when justified); "wait" = finish in-flight units first; "plan" = analysis/graph needed; ' +
      '"stop" = the run is over (budget spent, waiting for human, blocked, or completed). Call after every report_work. ' +
      'Only "stop" ends an OUTSIDE_MODE run.',
    input: c.SessionIdInput,
    output: c.NextWorkResult,
    annotations: WRITE,
    run: (a) => orchestrator.nextWork(a.sessionId),
  });

  tool('report_work', {
    title: 'Report work',
    description:
      'Report a claimed unit: progress (checkpoint), completed (requires validation evidence), failed, blocked (requires blocker), ' +
      'or released. Completed with failing checks counts as a failed attempt. Then call next_work: a finished unit never ends the session.',
    input: c.ReportWorkInput,
    output: c.ReportWorkResult,
    annotations: WRITE,
    run: (a) => orchestrator.reportWork(a),
  });

  // ─── decisions ────────────────────────────────────────────────────────────

  tool('request_decision', {
    title: 'Request human decision',
    description:
      'Queue a question that needs human judgment (architecture, product, scope, security...). Never guess instead. ' +
      'Affected units wait; everything else continues. Returns impact and the independent work that can proceed. ' +
      'Does not block and does not wait for an answer.',
    input: c.RequestDecisionInput,
    output: c.RequestDecisionResult,
    annotations: WRITE,
    run: (a) => orchestrator.requestDecision(a),
  });

  tool('get_decisions', {
    title: 'Get decisions',
    description: 'The decision queue, most blocking first, with why each matters, options, the agent suggestion and blocked/independent work.',
    input: c.GetDecisionsInput,
    output: c.DecisionsResult,
    annotations: READ,
    run: (a) => orchestrator.getDecisions(a),
  });

  tool('record_decision', {
    title: 'Record human decision',
    description:
      'Record a decision made by a human (or withdraw a question that no longer applies). Only call with the human\'s explicit answer. ' +
      'Refused while an OUTSIDE_MODE run is active. Releases the units the decision gated.',
    input: c.RecordDecisionInput,
    output: c.RecordDecisionResult,
    annotations: WRITE,
    run: (a) => orchestrator.recordDecision(a),
  });

  // ─── handoff & report ─────────────────────────────────────────────────────

  tool('get_handoff', {
    title: 'Get handoff',
    description:
      'Exactly where to pick up: state and why, decisions needed (most blocking first), in-flight checkpoints, ready units, ' +
      'blocked units with causes, completed work, project context, repository state and ordered next actions. Start DESK_MODE here.',
    input: c.SessionIdInput,
    output: c.HandoffView,
    annotations: READ,
    text: (h) => h.markdown,
    run: (a) => orchestrator.getHandoff(a.sessionId),
  });

  tool('get_session_report', {
    title: 'Get session report',
    description:
      'Session report: outcome, budget used and why any was left unused, completed work with validation evidence, unresolved work, ' +
      'decisions, parallel dispatches and their rationale, scope added mid-session, and next steps.',
    input: c.SessionIdInput,
    output: c.ReportView,
    annotations: READ,
    text: (r) => r.markdown,
    run: (a) => orchestrator.getReport(a.sessionId),
  });

  return server;
}
