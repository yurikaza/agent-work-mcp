import type { DecisionView, HandoffView, UnitBrief } from './contracts.js';
import { needsValidation, unvalidatedTaskUnits } from './evaluate.js';
import { orderDecisionQueue } from './model/decisions.js';
import type { ProjectSnapshot, SessionRecord } from './model/session.js';
import type { Policy } from './policy/policy.js';
import { budgetView, decisionView, graphOf, liveness, unitBrief } from './views.js';

/**
 * Where to pick up. Derived entirely from persisted state (plus an optional
 * fresh repository snapshot), so it exists even after a crash.
 */
export function buildHandoff(s: SessionRecord, now: Date, policy: Policy, snapshot?: ProjectSnapshot): HandoffView {
  const g = graphOf(s);
  const decisionsNeeded = orderDecisionQueue(
    s.decisions.filter((d) => d.status === 'open'),
    g,
  ).map((d) => decisionView(d, g));
  const inFlight = s.units.filter((u) => u.status === 'in_progress').map((u) => unitBrief(u, g));
  const readyNext = g.ready().map((u) => unitBrief(u, g));
  const blocked = g
    .remaining()
    .filter((u) => g.readiness(u) !== 'ready')
    .map((u) => unitBrief(u, g));
  const completed = s.units.filter((u) => u.status === 'done').map((u) => unitBrief(u, g));
  const repository = snapshot ?? s.snapshot;
  const nextActions = computeNextActions(s, decisionsNeeded, readyNext, blocked, inFlight, repository);

  const view: Omit<HandoffView, 'markdown'> = {
    sessionId: s.id,
    generatedAt: now.toISOString(),
    projectRoot: s.projectRoot,
    mode: s.mode,
    state: s.state,
    stateReason: s.stateReason,
    liveness: liveness(s, now, policy),
    phase: s.phase,
    projectContext: s.projectContext,
    budget: budgetView(s, now),
    decisionsNeeded,
    inFlight,
    readyNext,
    blocked,
    completed,
    repository,
    notes: [...s.handoffNotes],
    nextActions,
  };
  return { ...view, markdown: renderHandoff(view) };
}

export function computeNextActions(
  s: SessionRecord,
  decisions: DecisionView[],
  ready: UnitBrief[],
  blocked: UnitBrief[],
  inFlight: UnitBrief[],
  repository?: ProjectSnapshot,
): string[] {
  if (s.state === 'completed') return ['Review the session report and start the next phase in a new session.'];
  if (s.state === 'failed') return ['Review the session report; start a new session if the goal still stands.'];

  const actions: string[] = [];
  for (const d of decisions) {
    actions.push(`Decide ${d.id}: ${d.question} (blocks ${d.blockingCount} unit(s)) → record_decision`);
  }
  for (const u of blocked) {
    const unit = s.units.find((x) => x.id === u.id);
    if (unit?.status === 'blocked') {
      actions.push(`Unblock ${u.id}: ${unit.blocker?.detail ?? 'see notes'} → fix, then update_work_graph reopen`);
    } else if (unit?.status === 'failed') {
      actions.push(`Investigate failed ${u.id} (${unit.attempts} attempt(s)) → fix or re-plan, then update_work_graph reopen`);
    }
  }
  for (const u of inFlight) {
    actions.push(`Continue in-flight ${u.id}${u.checkpoint ? ` from checkpoint: ${u.checkpoint}` : ''}`);
  }
  const unvalidated = needsValidation(s) ? unvalidatedTaskUnits(s).length : 0;
  if (ready.length > 0 || unvalidated > 0 || !s.graphSubmitted) {
    const what = !s.graphSubmitted
      ? 'finish analysis and submit the work graph'
      : [ready.length ? `${ready.length} ready unit(s)` : '', unvalidated ? 'integration validation' : '']
          .filter(Boolean)
          .join(' and ');
    actions.push(
      `resume_session to continue ${what} (mode "outside" with addBudgetMinutes for autonomy, or "desk").`,
    );
  }
  const dirty = repository?.git?.dirtyFiles.length ?? 0;
  if (dirty > 0) {
    actions.push(`Review ${dirty} uncommitted file(s) on branch ${repository?.git?.branch ?? '(unknown)'} before resuming.`);
  }
  return actions;
}

function renderHandoff(h: Omit<HandoffView, 'markdown'>): string {
  const out: string[] = [];
  out.push(`# Handoff: ${h.phase.title}`);
  out.push('');
  out.push(`Session \`${h.sessionId}\` · mode **${h.mode}** · state **${h.state}** — ${h.stateReason}`);
  if (h.budget.totalMinutes > 0) {
    out.push(`Budget: ${h.budget.usedMinutes}m used of ${h.budget.totalMinutes}m (${h.budget.remainingMinutes}m left)`);
  }
  out.push(`Goal: ${h.phase.goal}`);

  section(out, 'Next actions', h.nextActions.map((a, i) => `${i + 1}. ${a}`));

  section(
    out,
    `Decisions needed (${h.decisionsNeeded.length})`,
    h.decisionsNeeded.flatMap((d) => [
      `- **${d.id}** [${d.category}, blocks ${d.blockingCount}] ${d.question}`,
      `  - Why it matters: ${d.whyItMatters}`,
      ...d.options.map((o) => `  - Option \`${o.id}\`: ${o.label}${o.consequences ? ` — ${o.consequences}` : ''}`),
      ...(d.recommendation ? [`  - Agent suggestion (not applied): ${d.recommendation}`] : []),
      ...(d.blockedUnitIds.length ? [`  - Blocks: ${d.blockedUnitIds.join(', ')}`] : []),
    ]),
  );
  section(out, 'In flight', h.inFlight.map((u) => `- ${u.id}: ${u.title}${u.checkpoint ? ` — checkpoint: ${u.checkpoint}` : ''}`));
  section(out, 'Ready next', h.readyNext.map((u) => `- ${u.id}: ${u.title}${u.estimateMinutes ? ` (~${u.estimateMinutes}m)` : ''}`));
  section(
    out,
    'Blocked / waiting',
    h.blocked.map((u) => `- ${u.id}: ${u.title} — ${u.readiness}${u.rootCauses.length ? ` (${u.rootCauses.join(', ')})` : ''}`),
  );
  section(out, 'Completed', h.completed.map((u) => `- ${u.id}: ${u.title}${u.summary ? ` — ${u.summary}` : ''}`));
  if (h.projectContext) {
    section(out, 'Project context', [
      h.projectContext.summary,
      ...(h.projectContext.keyFiles.length ? [`Key files: ${h.projectContext.keyFiles.join(', ')}`] : []),
      ...Object.entries(h.projectContext.commands).map(([k, v]) => `- ${k}: \`${v}\``),
      ...h.projectContext.notes.map((n) => `- ${n}`),
    ]);
  }
  if (h.repository?.git) {
    const git = h.repository.git;
    section(out, 'Repository', [
      `Branch ${git.branch ?? '(detached)'} @ ${git.head?.slice(0, 12) ?? '?'}; ${git.dirtyFiles.length} uncommitted file(s)`,
      ...git.dirtyFiles.slice(0, 20).map((f) => `- ${f}`),
    ]);
  }
  section(out, 'Notes', h.notes.map((n) => `- ${n}`));
  return out.join('\n');
}

export function section(out: string[], title: string, lines: string[]): void {
  if (lines.length === 0) return;
  out.push('', `## ${title}`, ...lines);
}
