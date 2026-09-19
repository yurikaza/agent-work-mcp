import type { ReportView } from './contracts.js';
import { unvalidatedTaskUnits } from './evaluate.js';
import { computeNextActions, section } from './handoff.js';
import { orderDecisionQueue } from './model/decisions.js';
import type { SessionRecord } from './model/session.js';
import { isTerminal } from './model/state-machine.js';
import type { Policy } from './policy/policy.js';
import { budgetView, decisionView, graphOf, unitBrief, unitCounts } from './views.js';

export function buildReport(s: SessionRecord, now: Date, _policy: Policy): ReportView {
  const g = graphOf(s);
  const budget = budgetView(s, now);
  const decisions = orderDecisionQueue(s.decisions, g).map((d) => decisionView(d, g));
  const open = decisions.filter((d) => d.status === 'open');
  const validationUnits = s.units.filter((u) => u.kind === 'validation');
  const parallel = s.dispatches.filter((d) => d.strategy === 'parallel');
  const unresolved = s.units
    .filter((u) => ['pending', 'blocked', 'failed', 'in_progress'].includes(u.status))
    .map((u) => unitBrief(u, g));

  const view: Omit<ReportView, 'markdown'> = {
    sessionId: s.id,
    generatedAt: now.toISOString(),
    outcome: s.state,
    stateReason: s.stateReason,
    phase: s.phase,
    budget: { ...budget, unusedReason: unusedBudgetReason(s, budget.remainingMinutes) },
    runs: s.runs.map((r) => ({ ...r })),
    unitCounts: unitCounts(s, g),
    completed: s.units
      .filter((u) => u.status === 'done' && u.result)
      .map((u) => ({
        id: u.id,
        title: u.title,
        summary: u.result!.summary,
        validation: u.result!.validation,
        validatedBy: u.validatedBy,
      })),
    unresolved,
    decisions: {
      raised: s.decisions.length,
      resolved: s.decisions.filter((d) => d.status === 'resolved').length,
      withdrawn: s.decisions.filter((d) => d.status === 'withdrawn').length,
      open: open.map((d) => ({ id: d.id, question: d.question, blockingCount: d.blockingCount })),
    },
    dispatches: {
      total: s.dispatches.length,
      parallel: parallel.length,
      parallelRationale: parallel.map((d) => `${d.id} [${d.unitIds.join(', ')}]: ${d.rationale.join(' ')}`),
    },
    validation: {
      runs: validationUnits.reduce((n, u) => n + u.attempts + (u.status === 'done' ? 1 : 0), 0),
      passed: validationUnits.filter((u) => u.status === 'done').length,
      failedAttempts: validationUnits.reduce((n, u) => n + u.attempts, 0),
      unvalidatedCompletedUnits: unvalidatedTaskUnits(s).map((u) => u.id),
    },
    scopeAddedMidSession: s.units
      .filter((u) => u.addedLate)
      .map((u) => ({ id: u.id, title: u.title, rationale: u.rationale ?? '' })),
    nextSteps: computeNextActions(
      s,
      open,
      g.ready().map((u) => unitBrief(u, g)),
      unresolved.filter((u) => u.status !== 'in_progress' && u.readiness !== 'ready'),
      unresolved.filter((u) => u.status === 'in_progress'),
      s.snapshot,
    ),
  };
  return { ...view, markdown: renderReport(view) };
}

function unusedBudgetReason(s: SessionRecord, remaining: number): string | undefined {
  if (s.budget.totalMinutes === 0 || remaining <= 0) return undefined;
  if (!(isTerminal(s.state) || ['waiting_for_human', 'blocked', 'resumable'].includes(s.state))) return undefined;
  switch (s.state) {
    case 'completed':
      return 'All meaningful work finished and validated; remaining budget intentionally left unused.';
    case 'waiting_for_human':
      return 'Remaining work depends on human decisions and no independent work was left.';
    case 'blocked':
      return 'Remaining work is blocked by blockers or failures that need a human.';
    default:
      return s.stateReason;
  }
}

function renderReport(r: Omit<ReportView, 'markdown'>): string {
  const out: string[] = [];
  out.push(`# Session report: ${r.phase.title}`);
  out.push('');
  out.push(`Outcome: **${r.outcome}** — ${r.stateReason}`);
  out.push(`Goal: ${r.phase.goal}`);
  if (r.budget.totalMinutes > 0) {
    out.push(
      `Budget: ${r.budget.usedMinutes}m of ${r.budget.totalMinutes}m used` +
        (r.budget.unusedReason ? ` — ${r.budget.remainingMinutes}m unused: ${r.budget.unusedReason}` : ''),
    );
  }
  const c = r.unitCounts;
  out.push(
    `Units: ${c.done} done, ${c.in_progress} in progress, ${c.pending} pending, ${c.blocked} blocked, ${c.failed} failed, ${c.cancelled} cancelled`,
  );
  section(
    out,
    'Completed work',
    r.completed.map(
      (u) =>
        `- ${u.id}: ${u.title} — ${u.summary} [checks: ${u.validation.checks.map((ch) => `${ch.name} ${ch.passed ? '✓' : '✗'}`).join(', ') || u.validation.notApplicableReason || 'none'}]` +
        (u.validatedBy ? ` (integrated: ${u.validatedBy})` : ''),
    ),
  );
  section(out, 'Unresolved', r.unresolved.map((u) => `- ${u.id}: ${u.title} — ${u.status}${u.rootCauses.length ? ` (${u.rootCauses.join(', ')})` : ''}`));
  section(out, 'Open decisions', r.decisions.open.map((d) => `- ${d.id} (blocks ${d.blockingCount}): ${d.question}`));
  out.push(
    '',
    `Decisions: ${r.decisions.raised} raised, ${r.decisions.resolved} resolved, ${r.decisions.withdrawn} withdrawn, ${r.decisions.open.length} open.`,
    `Dispatches: ${r.dispatches.total} (${r.dispatches.parallel} parallel).`,
    `Validation: ${r.validation.passed} passed run(s), ${r.validation.failedAttempts} failed attempt(s).` +
      (r.validation.unvalidatedCompletedUnits.length
        ? ` Not yet integration-validated: ${r.validation.unvalidatedCompletedUnits.join(', ')}.`
        : ''),
  );
  section(out, 'Parallel execution', r.dispatches.parallelRationale.map((p) => `- ${p}`));
  section(out, 'Scope added mid-session', r.scopeAddedMidSession.map((u) => `- ${u.id}: ${u.title} — ${u.rationale}`));
  section(out, 'Next steps', r.nextSteps.map((a, i) => `${i + 1}. ${a}`));
  return out.join('\n');
}
