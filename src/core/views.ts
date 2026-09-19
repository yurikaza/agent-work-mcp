import type {
  BudgetView,
  DecisionView,
  SessionSummary,
  SessionView,
  UnitBrief,
  UnitView,
} from './contracts.js';
import { remainingMinutes, usedMinutes } from './model/budget.js';
import { decisionImpact } from './model/decisions.js';
import type { Decision, SessionRecord, WorkUnit } from './model/session.js';
import { familyOf, isActive } from './model/state-machine.js';
import { formatCause, GraphIndex } from './model/work-graph.js';
import type { Policy } from './policy/policy.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

export function graphOf(s: SessionRecord): GraphIndex {
  return new GraphIndex(s.units, s.decisions);
}

export function liveness(s: SessionRecord, now: Date, policy: Policy): 'active' | 'stale' | 'idle' {
  if (!isActive(s.state)) return 'idle';
  const largestInFlight = Math.max(0, ...s.units.filter((u) => u.status === 'in_progress').map((u) => u.estimateMinutes ?? 0));
  const thresholdMs = Math.max(policy.staleAfterMinutes, 1.5 * largestInFlight) * 60_000;
  return now.getTime() - Date.parse(s.lastActivityAt) > thresholdMs ? 'stale' : 'active';
}

export function budgetView(s: SessionRecord, now: Date): BudgetView {
  return {
    totalMinutes: s.budget.totalMinutes,
    usedMinutes: round1(usedMinutes(s.budget, now)),
    remainingMinutes: round1(Math.max(0, remainingMinutes(s.budget, now))),
    clockRunning: s.budget.activeSince !== null,
  };
}

export function unitView(u: WorkUnit, g: GraphIndex): UnitView {
  return {
    id: u.id,
    title: u.title,
    description: u.description,
    kind: u.kind,
    status: u.status,
    readiness: g.readiness(u),
    rootCauses: g.rootCauses(u).map(formatCause),
    dependsOn: [...u.dependsOn],
    dependents: g.directDependents(u.id),
    decisionIds: [...u.decisionIds],
    estimateMinutes: u.estimateMinutes,
    priority: u.priority,
    acceptance: [...u.acceptance],
    workstream: u.workstream,
    touches: [...u.touches],
    parallelSafe: u.parallelSafe,
    rationale: u.rationale,
    addedLate: u.addedLate,
    attempts: u.attempts,
    claim: u.claim,
    checkpoint: u.checkpoint,
    blocker: u.blocker,
    result: u.result,
    notes: [...u.notes],
    validates: u.validates,
    validatedBy: u.validatedBy,
    cancelReason: u.cancelReason,
  };
}

export function unitBrief(u: WorkUnit, g: GraphIndex): UnitBrief {
  return {
    id: u.id,
    title: u.title,
    status: u.status,
    readiness: g.readiness(u),
    estimateMinutes: u.estimateMinutes,
    rootCauses: g.rootCauses(u).map(formatCause),
    checkpoint: u.checkpoint,
    summary: u.result?.summary ?? u.blocker?.detail,
  };
}

export function decisionView(d: Decision, g: GraphIndex): DecisionView {
  const impact = decisionImpact(d, g);
  return {
    id: d.id,
    question: d.question,
    whyItMatters: d.whyItMatters,
    category: d.category,
    options: d.options.map((o) => ({ ...o })),
    recommendation: d.recommendation,
    affectedUnitIds: [...d.affectedUnitIds],
    status: d.status,
    raisedAt: d.raisedAt,
    raisedInMode: d.raisedInMode,
    raisedDuringState: d.raisedDuringState,
    resolution: d.resolution,
    blockingCount: impact.blockedUnitIds.length,
    blockedUnitIds: impact.blockedUnitIds,
    independentReadyUnitIds: impact.independentReadyUnitIds,
  };
}

export function sessionSummary(s: SessionRecord, now: Date, policy: Policy): SessionSummary {
  return {
    sessionId: s.id,
    projectRoot: s.projectRoot,
    mode: s.mode,
    state: s.state,
    stateReason: s.stateReason,
    liveness: liveness(s, now, policy),
    phaseTitle: s.phase.title,
    goal: s.phase.goal,
    budget: budgetView(s, now),
    openDecisions: s.decisions.filter((d) => d.status === 'open').length,
    remainingUnits: s.units.filter((u) => ['pending', 'blocked', 'failed', 'in_progress'].includes(u.status)).length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastActivityAt: s.lastActivityAt,
  };
}

export function unitCounts(s: SessionRecord, g: GraphIndex): SessionView['counts'] {
  const count = (status: WorkUnit['status']) => s.units.filter((u) => u.status === status).length;
  return {
    total: s.units.length,
    pending: count('pending'),
    ready: g.ready().length,
    in_progress: count('in_progress'),
    done: count('done'),
    failed: count('failed'),
    blocked: count('blocked'),
    cancelled: count('cancelled'),
  };
}

export function inFlightViews(s: SessionRecord): SessionView['inFlight'] {
  return s.units
    .filter((u) => u.status === 'in_progress' && u.claim)
    .map((u) => ({
      unitId: u.id,
      title: u.title,
      executor: u.claim!.executor,
      isolation: u.claim!.isolation,
      claimedAt: u.claim!.at,
      checkpoint: u.checkpoint,
    }));
}

export function sessionView(s: SessionRecord, now: Date, policy: Policy): SessionView {
  const g = graphOf(s);
  return {
    ...sessionSummary(s, now, policy),
    family: familyOf(s.state),
    phase: { ...s.phase, exitCriteria: [...s.phase.exitCriteria], constraints: [...s.phase.constraints] },
    graphSubmitted: s.graphSubmitted,
    graphRevision: s.graphRevision,
    counts: unitCounts(s, g),
    inFlight: inFlightViews(s),
    runs: s.runs.map((r) => ({ ...r })),
  };
}
