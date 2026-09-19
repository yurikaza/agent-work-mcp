import { fitsBudget, remainingMinutes } from './model/budget.js';
import type { SessionRecord, WorkUnit } from './model/session.js';
import { formatCause, GraphIndex } from './model/work-graph.js';
import { planExecution, type ExecutionPlan } from './policy/execution-policy.js';
import type { Policy } from './policy/policy.js';

export type HaltState = 'resumable' | 'waiting_for_human' | 'blocked' | 'completed';
export type HaltReason = 'budget_exhausted' | 'budget_insufficient' | 'waiting_for_human' | 'blocked' | 'completed' | 'not_active';

export interface Halt {
  state: HaltState;
  reason: HaltReason;
  message: string;
}

export type Evaluation =
  | { kind: 'plan' }
  | { kind: 'execute'; plan: ExecutionPlan }
  | { kind: 'validate'; covers: string[] }
  | { kind: 'wait'; reason: string }
  | ({ kind: 'halt' } & Halt);

export const unvalidatedTaskUnits = (s: SessionRecord): WorkUnit[] =>
  s.units.filter((u) => u.kind === 'task' && u.status === 'done' && !u.validatedBy);

/**
 * Decide what an active session does next. Pure: reads the record, never
 * mutates it. The orchestrator applies the result.
 */
export function evaluate(s: SessionRecord, now: Date, policy: Policy): Evaluation {
  if (!s.graphSubmitted) return { kind: 'plan' };

  const g = new GraphIndex(s.units, s.decisions);
  const inFlight = g.inFlight();
  const readyTasks = g.ready().filter((u) => u.kind !== 'validation');
  const unvalidated = unvalidatedTaskUnits(s);
  const outside = s.mode === 'outside';
  const remaining = outside ? remainingMinutes(s.budget, now) : Number.POSITIVE_INFINITY;

  if (outside && remaining <= 0) {
    if (inFlight.length > 0) {
      return {
        kind: 'wait',
        reason:
          'Autonomous budget is exhausted. Do not start anything new: finish or checkpoint the in-flight units, ' +
          'report them with report_work, then call next_work.',
      };
    }
    if (unvalidated.length > 0) return { kind: 'validate', covers: unvalidated.map((u) => u.id) };
    if (readyTasks.length > 0) {
      return {
        kind: 'halt',
        state: 'resumable',
        reason: 'budget_exhausted',
        message: `Budget exhausted with ${readyTasks.length} ready unit(s) remaining.`,
      };
    }
    return { kind: 'halt', ...classifyHalt(s, g) };
  }

  const fitting = outside ? readyTasks.filter((u) => fitsBudget(u.estimateMinutes, remaining, policy)) : readyTasks;
  if (fitting.length > 0) {
    const plan = planExecution(fitting, inFlight, { mode: s.mode, policy });
    if (plan.assignments.length > 0) return { kind: 'execute', plan };
    return { kind: 'wait', reason: plan.rationale.join(' ') };
  }
  if (inFlight.length > 0) {
    return { kind: 'wait', reason: `${inFlight.length} unit(s) in flight; finish and report them, then call next_work.` };
  }
  if (unvalidated.length > 0) return { kind: 'validate', covers: unvalidated.map((u) => u.id) };
  if (readyTasks.length > 0) {
    const smallest = Math.min(...readyTasks.map((u) => u.estimateMinutes ?? Number.POSITIVE_INFINITY));
    return {
      kind: 'halt',
      state: 'resumable',
      reason: 'budget_insufficient',
      message:
        `~${Math.max(0, Math.round(remaining))}m of budget left; no ready unit fits ` +
        `(smallest estimate ${Number.isFinite(smallest) ? `${smallest}m` : 'unknown'}, ${policy.budgetReserveMinutes}m reserved for validation).`,
    };
  }
  return { kind: 'halt', ...classifyHalt(s, g) };
}

/**
 * Classify a session that has nothing executing. Ignores budget: used when a
 * run ends for any reason and when a human changes the graph or decisions.
 */
export function classifyHalt(s: SessionRecord, g: GraphIndex = new GraphIndex(s.units, s.decisions)): Halt {
  if (!s.graphSubmitted) {
    return { state: 'resumable', reason: 'not_active', message: 'Analysis not finished: no work graph submitted yet.' };
  }
  const ready = g.ready();
  const unvalidated = unvalidatedTaskUnits(s);
  if (g.inFlight().length > 0 || ready.length > 0 || unvalidated.length > 0) {
    const parts = [
      ready.length ? `${ready.length} ready unit(s)` : '',
      unvalidated.length ? `${unvalidated.length} completed unit(s) awaiting validation` : '',
      g.inFlight().length ? `${g.inFlight().length} in-flight unit(s)` : '',
    ].filter(Boolean);
    return { state: 'resumable', reason: 'not_active', message: `Executable work remains: ${parts.join(', ')}.` };
  }
  const remaining = g.remaining();
  if (remaining.length === 0) {
    return { state: 'completed', reason: 'completed', message: 'All units are done or cancelled and completed work is validated.' };
  }
  const causes = new Set(remaining.flatMap((u) => g.rootCauses(u).map(formatCause)));
  const decisions = [...causes].filter((c) => c.startsWith('decision:')).map((c) => c.slice('decision:'.length));
  if (decisions.length > 0) {
    return {
      state: 'waiting_for_human',
      reason: 'waiting_for_human',
      message: `${remaining.length} remaining unit(s) cannot proceed; waiting on decision(s) ${decisions.join(', ')}.`,
    };
  }
  return {
    state: 'blocked',
    reason: 'blocked',
    message: `${remaining.length} remaining unit(s) cannot proceed: ${[...causes].join(', ') || 'unknown cause'}.`,
  };
}
