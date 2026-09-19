import { resolve } from 'node:path';
import type {
  DecisionsResult,
  GetDecisionsInput,
  GetWorkGraphInput,
  HandoffView,
  ListSessionsInput,
  ListSessionsResult,
  NextWorkResult,
  PauseSessionInput,
  PhaseResult,
  RecordDecisionInput,
  RecordDecisionResult,
  ReportView,
  ReportWorkInput,
  ReportWorkResult,
  RequestDecisionInput,
  RequestDecisionResult,
  ResumeSessionInput,
  ResumeSessionResult,
  SessionResult,
  StartSessionInput,
  StartSessionResult,
  StopSessionInput,
  StopSessionResult,
  UnitInput,
  UpdateWorkGraphInput,
  UpdateWorkGraphResult,
  WorkGraphResult,
} from './contracts.js';
import { DomainError, fail } from './errors.js';
import { classifyHalt, evaluate } from './evaluate.js';
import {
  AFTER_REPORT,
  ANALYSIS_GUIDANCE,
  decisionRecordedGuidance,
  STOP_GUIDANCE,
} from './guidance.js';
import { buildHandoff } from './handoff.js';
import { remainingMinutes, startClock, stopClock } from './model/budget.js';
import { orderDecisionQueue } from './model/decisions.js';
import type {
  Decision,
  DispatchRecord,
  ProjectSnapshot,
  SessionRecord,
  SessionState,
  WorkUnit,
} from './model/session.js';
import { assertTransition, isActive, isHalted, isTerminal } from './model/state-machine.js';
import { assertGraphValid, UNIT_ID_PATTERN } from './model/work-graph.js';
import type { ExecutionPlan } from './policy/execution-policy.js';
import { DEFAULT_POLICY, type Policy } from './policy/policy.js';
import type { Clock, IdGenerator, ProjectInspector, SessionRepository } from './ports.js';
import { systemClock } from './ports.js';
import { buildReport } from './report.js';
import {
  budgetView,
  decisionView,
  graphOf,
  inFlightViews,
  liveness,
  sessionSummary,
  sessionView,
  unitView,
} from './views.js';

export interface OrchestratorOptions {
  repository: SessionRepository;
  clock?: Clock;
  ids?: IdGenerator;
  inspector?: ProjectInspector;
  policy?: Partial<Policy>;
  /** Project root used when start_session does not name one. */
  defaultProjectRoot?: string;
}

const randomIds: IdGenerator = { sessionId: () => `ses_${crypto.randomUUID().replace(/-/g, '')}` };

/**
 * Application service. Every public method is one use case; each mutation loads
 * the session, applies the change in memory, and saves it atomically. A thrown
 * error leaves the stored session untouched.
 */
export class Orchestrator {
  readonly policy: Policy;
  private readonly repo: SessionRepository;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly inspector?: ProjectInspector;
  private readonly defaultRoot: string;
  private readonly locks = new KeyedLock();

  constructor(opts: OrchestratorOptions) {
    this.repo = opts.repository;
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.ids ?? randomIds;
    this.inspector = opts.inspector;
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.defaultRoot = opts.defaultProjectRoot ?? process.cwd();
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  async startSession(input: StartSessionInput): Promise<StartSessionResult> {
    const now = this.clock.now();
    if (input.mode === 'outside' && !input.budgetMinutes) {
      fail('BUDGET_REQUIRED', 'OUTSIDE_MODE needs budgetMinutes: the total autonomous wall-clock budget for the session.');
    }
    const root = resolve(input.projectRoot ?? this.defaultRoot);
    const existing = (await this.repo.list()).filter((s) => s.projectRoot === root && !isTerminal(s.state));
    const running = existing.find((s) => isActive(s.state) && liveness(s, now, this.policy) === 'active');
    if (running) {
      fail(
        'SESSION_CONFLICT',
        `Session ${running.id} is actively ${running.state} on this project. Pause or stop it first, ` +
          'or resume it instead of starting a new one.',
      );
    }

    const iso = now.toISOString();
    const s: SessionRecord = {
      schemaVersion: 1,
      id: this.ids.sessionId(),
      revision: 0,
      projectRoot: root,
      mode: input.mode,
      state: 'idle',
      stateReason: 'created',
      createdAt: iso,
      updatedAt: iso,
      lastActivityAt: iso,
      phase: {
        title: input.phaseTitle?.trim() || input.goal,
        goal: input.goal,
        exitCriteria: input.exitCriteria ?? [],
        constraints: input.constraints ?? [],
      },
      budget: { totalMinutes: input.budgetMinutes ?? 0, consumedMs: 0, activeSince: null },
      graphSubmitted: false,
      graphRevision: 0,
      units: [],
      decisions: [],
      runs: [],
      dispatches: [],
      events: [],
      handoffNotes: [],
      counters: { decision: 0, validation: 0, dispatch: 0 },
    };
    logEvent(s, now, 'created', `Session created in ${input.mode} mode: ${input.goal}`);
    transition(s, 'analyzing', 'session started; analyzing the project', now);
    s.snapshot = await this.snapshot(root);
    await this.repo.create(s);

    const docs = s.snapshot?.docs ?? [];
    return {
      session: sessionView(s, now, this.policy),
      snapshot: s.snapshot,
      otherSessions: existing.map((x) => sessionSummary(x, now, this.policy)),
      guidance: docs.length ? `${ANALYSIS_GUIDANCE} Docs found: ${docs.join(', ')}.` : ANALYSIS_GUIDANCE,
    };
  }

  pauseSession(input: PauseSessionInput): Promise<SessionResult> {
    return this.mutate(input.sessionId, async (s, now) => {
      if (!isActive(s.state)) fail('SESSION_NOT_ACTIVE', `Only an active session can be paused; this one is ${s.state}.`);
      s.handoffNotes.push(...(input.notes ?? []));
      transition(s, 'paused', input.reason?.trim() || 'paused', now);
      s.snapshot = await this.snapshot(s.projectRoot);
      return {
        session: sessionView(s, now, this.policy),
        guidance: 'Paused. The budget clock is stopped and in-flight claims are kept. Stop working until resume_session.',
      };
    });
  }

  resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult> {
    return this.mutate(input.sessionId, async (s, now) => {
      if (isTerminal(s.state)) fail('SESSION_TERMINAL', `Session is ${s.state} and cannot be resumed.`);
      let recovered = false;
      const released: string[] = [];

      if (isActive(s.state)) {
        const live = liveness(s, now, this.policy);
        if (live === 'active' && !input.takeover) {
          const mins = Math.round((now.getTime() - Date.parse(s.lastActivityAt)) / 60_000);
          fail(
            'SESSION_ACTIVE',
            `Session is ${s.state} (last activity ${mins}m ago). If the previous agent is gone, pass takeover: true.`,
          );
        }
        // Interrupted: close the run and the budget at the last known activity, not now.
        const at = new Date(Math.min(now.getTime(), Date.parse(s.lastActivityAt)));
        stopClock(s.budget, at);
        closeRun(s, at, 'interrupted');
        for (const u of s.units.filter((x) => x.status === 'in_progress')) {
          releaseUnit(u, 'Released after interruption; resume from the checkpoint.');
          released.push(u.id);
        }
        logEvent(s, now, 'recovered', `Recovered from interruption; released ${released.length} unit(s).`);
        recovered = true;
      }

      if (input.mode) s.mode = input.mode;
      if (input.addBudgetMinutes) {
        s.budget.totalMinutes += input.addBudgetMinutes;
        logEvent(s, now, 'budget', `Budget extended by ${input.addBudgetMinutes}m to ${s.budget.totalMinutes}m.`);
      }
      if (s.mode === 'outside' && remainingMinutes(s.budget, now) <= 0) {
        fail('BUDGET_EXHAUSTED', 'No autonomous budget left. Pass addBudgetMinutes, or resume in desk mode.');
      }

      const inFlight = s.units.filter((u) => u.status === 'in_progress');
      const target: SessionState = !s.graphSubmitted
        ? 'analyzing'
        : s.state === 'paused' && inFlight.length > 0
          ? inFlight.some((u) => u.kind === 'validation')
            ? 'validating'
            : 'running'
          : 'planning';
      transition(s, target, `resumed in ${s.mode} mode${recovered ? ' after interruption' : ''}`, now);

      const guidance =
        target === 'analyzing'
          ? ANALYSIS_GUIDANCE
          : 'Resumed. Read the handoff (resolved decisions are attached to unit notes, in-flight checkpoints are listed), then call next_work.';
      return {
        session: sessionView(s, now, this.policy),
        recoveredFromInterruption: recovered,
        releasedUnitIds: released,
        handoff: buildHandoff(s, now, this.policy),
        guidance,
      };
    });
  }

  stopSession(input: StopSessionInput): Promise<StopSessionResult> {
    return this.mutate(input.sessionId, async (s, now) => {
      if (isTerminal(s.state)) fail('SESSION_TERMINAL', `Session is already ${s.state}.`);
      s.handoffNotes.push(...(input.notes ?? []));
      for (const u of s.units.filter((x) => x.status === 'in_progress')) {
        releaseUnit(u, `Released by stop_session: ${input.reason}`);
      }
      if (input.markFailed) {
        transition(s, 'failed', `stopped as failed: ${input.reason}`, now);
      } else if (isActive(s.state) || s.state === 'paused') {
        const halt = classifyHalt(s);
        transition(s, halt.state, `stopped: ${input.reason}. ${halt.message}`, now);
      } else {
        logEvent(s, now, 'stop', `stop_session on halted session: ${input.reason}`);
      }
      s.snapshot = await this.snapshot(s.projectRoot);
      return { session: sessionView(s, now, this.policy), report: buildReport(s, now, this.policy) };
    });
  }

  // ─── work graph ────────────────────────────────────────────────────────────

  updateWorkGraph(input: UpdateWorkGraphInput): Promise<UpdateWorkGraphResult> {
    return this.mutate(input.sessionId, (s, now) => {
      assertNotTerminal(s);
      const iso = now.toISOString();
      const draft: WorkUnit[] = structuredClone(s.units);
      const byId = new Map(draft.map((u) => [u.id, u]));
      const late = s.graphSubmitted;
      const added: string[] = [];
      const updated: string[] = [];
      const cancelled: string[] = [];
      const reopened: string[] = [];

      const seen = new Set<string>();
      for (const spec of input.units ?? []) {
        if (seen.has(spec.id)) fail('GRAPH_INVALID', `Unit '${spec.id}' appears twice in this update.`);
        seen.add(spec.id);
        if (!UNIT_ID_PATTERN.test(spec.id)) fail('GRAPH_INVALID', `Unit id '${spec.id}' must match ${UNIT_ID_PATTERN}.`);
        const existing = byId.get(spec.id);
        if (existing) {
          if (existing.kind === 'validation') {
            fail('UNIT_IMMUTABLE', `'${spec.id}' is a validation unit managed by the orchestrator.`);
          }
          if (existing.status === 'done' || existing.status === 'cancelled') {
            fail('UNIT_IMMUTABLE', `Unit '${spec.id}' is ${existing.status}; add a new unit instead (or reopen a cancelled one).`);
          }
          applyUnitSpec(existing, spec);
          updated.push(spec.id);
        } else {
          if (!spec.title?.trim()) fail('INVALID_INPUT', `New unit '${spec.id}' needs a title.`);
          if (late && !spec.rationale?.trim()) {
            fail(
              'RATIONALE_REQUIRED',
              `Unit '${spec.id}' is added after the initial plan and needs a rationale tying it to the goal. ` +
                'Do not add work just to use remaining budget.',
            );
          }
          const unit = newUnit(spec, iso, late);
          draft.push(unit);
          byId.set(unit.id, unit);
          added.push(unit.id);
        }
      }

      for (const c of input.cancel ?? []) {
        const u = byId.get(c.id) ?? fail('NOT_FOUND', `Unknown unit '${c.id}'.`);
        if (u.status === 'done') fail('UNIT_IMMUTABLE', `Unit '${c.id}' is done and cannot be cancelled.`);
        if (u.kind === 'validation') fail('UNIT_IMMUTABLE', 'Validation units cannot be cancelled.');
        if (u.status === 'cancelled') continue;
        u.status = 'cancelled';
        u.cancelReason = c.reason;
        u.claim = undefined;
        u.notes.push(`Cancelled: ${c.reason}`);
        cancelled.push(u.id);
      }

      for (const r of input.reopen ?? []) {
        const u = byId.get(r.id) ?? fail('NOT_FOUND', `Unknown unit '${r.id}'.`);
        if (!['blocked', 'failed', 'cancelled'].includes(u.status)) {
          fail('INVALID_INPUT', `Only blocked, failed or cancelled units can be reopened; '${r.id}' is ${u.status}.`);
        }
        u.status = 'pending';
        u.attempts = 0;
        u.blocker = undefined;
        u.cancelReason = undefined;
        u.notes.push(`Reopened: ${r.note}`);
        reopened.push(u.id);
      }

      assertGraphValid(draft, s.decisions);
      s.units = draft;

      if (input.projectContext) {
        const prev = s.projectContext;
        const ctx = input.projectContext;
        s.projectContext = {
          summary: ctx.summary ?? prev?.summary ?? '',
          keyFiles: ctx.keyFiles ?? prev?.keyFiles ?? [],
          commands: { ...prev?.commands, ...ctx.commands },
          notes: [...(prev?.notes ?? []), ...(ctx.notes ?? [])],
          updatedAt: iso,
        };
      }

      s.graphRevision++;
      logEvent(
        s,
        now,
        'graph',
        `Graph r${s.graphRevision}: +${added.length} ~${updated.length} -${cancelled.length} reopened ${reopened.length}`,
      );

      if (!s.graphSubmitted) {
        s.graphSubmitted = true;
        if (s.state === 'analyzing') transition(s, 'planning', 'work graph submitted', now);
      } else if (s.state === 'analyzing') {
        transition(s, 'planning', 'work graph updated', now);
      } else if (s.state === 'running' && !hasInFlight(s)) {
        transition(s, 'planning', 're-evaluating after graph update', now);
      } else {
        this.reclassifyHalted(s, now);
      }

      return {
        sessionId: s.id,
        state: s.state,
        graphRevision: s.graphRevision,
        added,
        updated,
        cancelled,
        reopened,
        readyUnitIds: graphOf(s).ready().map((u) => u.id),
        guidance: isActive(s.state)
          ? 'Graph accepted. Call next_work to get the next dispatch.'
          : `Graph accepted. Session is ${s.state}; resume_session continues it.`,
      };
    });
  }

  // ─── execution loop ────────────────────────────────────────────────────────

  nextWork(sessionId: string): Promise<NextWorkResult> {
    return this.mutate(sessionId, async (s, now) => {
      const result = (
        action: NextWorkResult['action'],
        guidance: string,
        extra: Partial<NextWorkResult> = {},
      ): NextWorkResult => ({
        sessionId: s.id,
        mode: s.mode,
        state: s.state,
        action,
        inFlight: inFlightViews(s),
        budget: budgetView(s, now),
        openDecisions: s.decisions.filter((d) => d.status === 'open').length,
        guidance,
        ...extra,
      });

      if (!isActive(s.state)) {
        const reason: NextWorkResult['stopReason'] =
          s.state === 'completed' || s.state === 'failed' || s.state === 'paused'
            ? s.state
            : s.state === 'waiting_for_human' || s.state === 'blocked'
              ? s.state
              : 'not_active';
        return result('stop', `${STOP_GUIDANCE[reason]} (${s.stateReason})`, { stopReason: reason });
      }

      const ev = evaluate(s, now, this.policy);
      switch (ev.kind) {
        case 'plan':
          return result('plan', ANALYSIS_GUIDANCE);

        case 'wait':
          return result('wait', ev.reason);

        case 'execute': {
          const dispatch = this.dispatch(s, now, ev.plan);
          transition(s, 'running', `executing ${ev.plan.assignments.length} unit(s) (${ev.plan.strategy})`, now);
          return result('execute', executeGuidance(ev.plan), { dispatch: this.dispatchView(s, dispatch, ev.plan) });
        }

        case 'validate': {
          const unit = this.ensureValidationUnit(s, now, ev.covers);
          const plan: ExecutionPlan = {
            strategy: 'direct',
            assignments: [{ unitId: unit.id, executor: 'main', isolation: 'shared' }],
            rationale: [`Integration validation of ${ev.covers.length} completed unit(s) before the run can halt.`],
          };
          const dispatch = this.dispatch(s, now, plan);
          transition(s, 'validating', `integration validation (${unit.id})`, now);
          return result(
            'execute',
            'Run integration validation yourself: the full test suite, build and lint (see projectContext.commands), and check ' +
              'the acceptance list across the covered units together. Report with report_work including every check. ' +
              'If something fails, add fix units with update_work_graph; validation re-runs after them.',
            { dispatch: this.dispatchView(s, dispatch, plan) },
          );
        }

        case 'halt': {
          transition(s, ev.state, ev.message, now);
          s.snapshot = await this.snapshot(s.projectRoot);
          return result('stop', `${STOP_GUIDANCE[ev.reason]} ${ev.message}`, { stopReason: ev.reason });
        }
      }
    });
  }

  reportWork(input: ReportWorkInput): Promise<ReportWorkResult> {
    return this.mutate(input.sessionId, (s, now) => {
      assertNotTerminal(s);
      const iso = now.toISOString();
      const readyBefore = new Set(graphOf(s).ready().map((u) => u.id));
      const u = findUnit(s, input.unitId);
      if (u.status !== 'in_progress') {
        fail(
          'UNIT_NOT_CLAIMED',
          `Unit '${u.id}' is ${u.status}. Only units claimed through next_work (in_progress) can be reported.`,
        );
      }
      if (input.artifacts?.length) u.notes.push(`Artifacts: ${input.artifacts.join(', ')}`);

      let guidance = AFTER_REPORT;
      switch (input.outcome) {
        case 'progress':
          u.checkpoint = input.checkpoint ?? input.summary;
          u.notes.push(`Progress: ${input.summary}`);
          guidance = 'Checkpoint saved. Continue the unit.';
          break;

        case 'completed': {
          const v = input.validation;
          if (!v) {
            fail(
              'VALIDATION_REQUIRED',
              'Completing a unit requires validation evidence: run the relevant checks (tests, build, acceptance criteria) and pass them in validation.',
            );
          }
          if (v.checks.length === 0 && !v.notApplicableReason?.trim()) {
            fail('VALIDATION_REQUIRED', 'Validation needs at least one check, or notApplicableReason explaining why none applies.');
          }
          const failedChecks = v.checks.filter((c) => !c.passed).map((c) => c.name);
          if (!v.passed || failedChecks.length > 0) {
            guidance = this.failAttempt(
              u,
              `Validation failed${failedChecks.length ? `: ${failedChecks.join(', ')}` : ''}. ${input.summary}`,
              input.checkpoint,
            );
            break;
          }
          u.status = 'done';
          u.claim = undefined;
          u.checkpoint = undefined;
          u.result = {
            summary: input.summary,
            validation: {
              passed: true,
              checks: v.checks.map((c) => ({ ...c })),
              ...(v.notApplicableReason ? { notApplicableReason: v.notApplicableReason } : {}),
            },
            artifacts: input.artifacts ?? [],
            completedAt: iso,
          };
          if (u.kind === 'validation') {
            for (const id of u.validates ?? []) {
              const covered = s.units.find((x) => x.id === id);
              if (covered) covered.validatedBy = u.id;
            }
          }
          break;
        }

        case 'failed':
          guidance = this.failAttempt(u, input.summary, input.checkpoint);
          break;

        case 'blocked': {
          if (!input.blocker) fail('INVALID_INPUT', "outcome 'blocked' needs blocker { kind, detail }.");
          u.status = 'blocked';
          u.claim = undefined;
          u.blocker = { ...input.blocker, at: iso };
          if (input.checkpoint) u.checkpoint = input.checkpoint;
          u.notes.push(`Blocked (${input.blocker.kind}): ${input.blocker.detail}`);
          guidance = 'Blocker recorded; dependents wait. Call next_work to continue with independent work.';
          break;
        }

        case 'released':
          releaseUnit(u, `Released: ${input.summary}`);
          if (input.checkpoint) u.checkpoint = input.checkpoint;
          guidance = 'Unit released back to the queue. Call next_work.';
          break;
      }
      logEvent(s, now, 'report', `${u.id}: ${input.outcome} → ${u.status}`);

      if (isActive(s.state) && s.state !== 'analyzing' && !hasInFlight(s)) {
        transition(s, 'planning', `re-evaluating after ${u.id} ${input.outcome}`, now);
      }
      const newlyReady = graphOf(s)
        .ready()
        .map((x) => x.id)
        .filter((id) => !readyBefore.has(id));
      if (input.outcome === 'completed' && u.status === 'done' && newlyReady.length) {
        guidance += ` Newly ready: ${newlyReady.join(', ')}.`;
      }
      return { sessionId: s.id, state: s.state, unit: unitView(u, graphOf(s)), newlyReadyUnitIds: newlyReady, guidance };
    });
  }

  // ─── decisions ─────────────────────────────────────────────────────────────

  requestDecision(input: RequestDecisionInput): Promise<RequestDecisionResult> {
    return this.mutate(input.sessionId, (s, now) => {
      assertNotTerminal(s);
      const affected = [...new Set(input.affectedUnitIds ?? [])].map((id) => findUnit(s, id));
      for (const u of affected) {
        if (u.status === 'done' || u.status === 'cancelled') {
          fail('INVALID_INPUT', `Unit '${u.id}' is ${u.status}; a decision cannot gate it.`);
        }
      }
      const d: Decision = {
        id: `dec-${++s.counters.decision}`,
        question: input.question,
        whyItMatters: input.whyItMatters,
        category: input.category ?? 'other',
        options: (input.options ?? []).map((o, i) => ({
          id: o.id?.trim() || `opt-${i + 1}`,
          label: o.label,
          ...(o.consequences ? { consequences: o.consequences } : {}),
        })),
        recommendation: input.recommendation,
        affectedUnitIds: affected.map((u) => u.id),
        status: 'open',
        raisedAt: now.toISOString(),
        raisedInMode: s.mode,
        raisedDuringState: s.state,
      };
      s.decisions.push(d);

      const released: string[] = [];
      for (const u of affected) {
        if (!u.decisionIds.includes(d.id)) u.decisionIds.push(d.id);
        if (u.status === 'in_progress') {
          releaseUnit(u, `Paused for decision ${d.id}.`);
          if (input.checkpoint) u.checkpoint = input.checkpoint;
          released.push(u.id);
        }
      }
      logEvent(s, now, 'decision', `${d.id} raised: ${d.question}`);

      if (isActive(s.state) && s.state !== 'analyzing' && !hasInFlight(s)) {
        transition(s, 'planning', `re-evaluating after decision ${d.id} was queued`, now);
      } else {
        this.reclassifyHalted(s, now);
      }
      const view = decisionView(d, graphOf(s));
      return {
        sessionId: s.id,
        state: s.state,
        decision: view,
        releasedUnitIds: released,
        guidance: decisionRecordedGuidance(view.independentReadyUnitIds.length),
      };
    });
  }

  recordDecision(input: RecordDecisionInput): Promise<RecordDecisionResult> {
    return this.mutate(input.sessionId, (s, now) => {
      assertNotTerminal(s);
      const d = s.decisions.find((x) => x.id === input.decisionId) ?? fail('NOT_FOUND', `Unknown decision '${input.decisionId}'.`);
      if (d.status !== 'open') fail('DECISION_NOT_OPEN', `Decision ${d.id} is already ${d.status}.`);
      if (!canRecordDecisions(s)) {
        fail(
          'DECISION_REQUIRES_HUMAN',
          `Decisions are made by a human. Session is running autonomously (OUTSIDE_MODE, ${s.state}). ` +
            'Leave the decision in the queue and continue independent work. A human resolves it after the run halts ' +
            '(or after pause_session / resume_session in desk mode).',
        );
      }
      if (!input.withdraw && !input.choice?.trim()) fail('INVALID_INPUT', 'choice is required unless withdraw is true.');

      const readyBefore = new Set(graphOf(s).ready().map((u) => u.id));
      d.status = input.withdraw ? 'withdrawn' : 'resolved';
      d.resolution = {
        choice: input.withdraw ? '(withdrawn)' : input.choice!.trim(),
        ...(input.rationale ? { rationale: input.rationale } : {}),
        decidedBy: input.decidedBy,
        decidedAt: now.toISOString(),
      };
      const note = input.withdraw
        ? `Decision ${d.id} withdrawn by ${input.decidedBy}: the question no longer applies.`
        : `Decision ${d.id} resolved by ${input.decidedBy}: ${d.resolution.choice}${input.rationale ? ` — ${input.rationale}` : ''}`;
      for (const u of s.units.filter((x) => x.decisionIds.includes(d.id))) u.notes.push(note);
      logEvent(s, now, 'decision', note);
      this.reclassifyHalted(s, now);

      const g = graphOf(s);
      const unblocked = g
        .ready()
        .map((u) => u.id)
        .filter((id) => !readyBefore.has(id));
      return {
        sessionId: s.id,
        state: s.state,
        decision: decisionView(d, g),
        unblockedUnitIds: unblocked,
        guidance: isActive(s.state)
          ? 'Recorded. Call next_work to continue.'
          : `Recorded; ${unblocked.length} unit(s) became ready. Session is ${s.state}. Resolve remaining decisions, then resume_session.`,
      };
    });
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  getSession(sessionId: string): Promise<SessionResult> {
    return this.read(sessionId, (s, now) => ({
      session: sessionView(s, now, this.policy),
      guidance: stateGuidance(s),
    }));
  }

  async listSessions(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
    const now = this.clock.now();
    const root = input.projectRoot ? resolve(input.projectRoot) : undefined;
    const sessions = (await this.repo.list())
      .filter((s) => (!root || s.projectRoot === root) && (input.includeTerminal !== false || !isTerminal(s.state)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((s) => sessionSummary(s, now, this.policy));
    return { sessions };
  }

  getPhase(sessionId: string): Promise<PhaseResult> {
    return this.read(sessionId, (s) => {
      const count = (...st: WorkUnit['status'][]) => s.units.filter((u) => u.kind !== 'validation' && st.includes(u.status)).length;
      const total = s.units.filter((u) => u.kind !== 'validation').length;
      const done = count('done');
      const cancelled = count('cancelled');
      const denominator = total - cancelled;
      return {
        sessionId: s.id,
        state: s.state,
        phase: s.phase,
        progress: {
          totalUnits: total,
          done,
          remaining: count('pending', 'blocked', 'failed'),
          inFlight: count('in_progress'),
          cancelled,
          percentDone: denominator > 0 ? Math.round((done / denominator) * 100) : 0,
        },
        openDecisions: s.decisions.filter((d) => d.status === 'open').length,
        projectContext: s.projectContext,
      };
    });
  }

  getWorkGraph(input: GetWorkGraphInput): Promise<WorkGraphResult> {
    return this.read(input.sessionId, (s) => {
      const g = graphOf(s);
      const filter = input.filter ?? 'all';
      const include = (u: WorkUnit): boolean => {
        switch (filter) {
          case 'all':
            return true;
          case 'remaining':
            return ['pending', 'blocked', 'failed', 'in_progress'].includes(u.status);
          case 'ready':
            return g.readiness(u) === 'ready';
          default:
            return u.status === filter;
        }
      };
      const units = s.units.filter(include);
      return {
        sessionId: s.id,
        state: s.state,
        graphRevision: s.graphRevision,
        units: units.map((u) => unitView(u, g)),
        edges: units.flatMap((u) => u.dependsOn.map((to) => ({ from: u.id, to }))),
      };
    });
  }

  getDecisions(input: GetDecisionsInput): Promise<DecisionsResult> {
    return this.read(input.sessionId, (s) => {
      const g = graphOf(s);
      const status = input.status ?? 'open';
      const decisions = orderDecisionQueue(
        s.decisions.filter((d) => status === 'all' || d.status === status),
        g,
      ).map((d) => decisionView(d, g));
      return { sessionId: s.id, state: s.state, mode: s.mode, canRecordDecisions: canRecordDecisions(s), decisions };
    });
  }

  async getHandoff(sessionId: string): Promise<HandoffView> {
    const s = await this.load(sessionId);
    const fresh = await this.snapshot(s.projectRoot);
    return buildHandoff(s, this.clock.now(), this.policy, fresh);
  }

  getReport(sessionId: string): Promise<ReportView> {
    return this.read(sessionId, (s, now) => buildReport(s, now, this.policy));
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private failAttempt(u: WorkUnit, reason: string, checkpoint?: string): string {
    u.attempts++;
    u.claim = undefined;
    if (checkpoint) u.checkpoint = checkpoint;
    u.notes.push(`Attempt ${u.attempts} failed: ${reason}`);
    if (u.attempts >= this.policy.maxAttempts) {
      u.status = 'failed';
      return `'${u.id}' failed after ${u.attempts} attempt(s); its dependents are blocked until a human reopens it. Call next_work to continue with independent work.`;
    }
    u.status = 'pending';
    return u.kind === 'validation'
      ? `Validation failed (attempt ${u.attempts}/${this.policy.maxAttempts}). Add fix units with update_work_graph (they run first), then call next_work.`
      : `Attempt ${u.attempts}/${this.policy.maxAttempts} recorded. Call next_work; consider splitting or fixing the unit with update_work_graph.`;
  }

  private dispatch(s: SessionRecord, now: Date, plan: ExecutionPlan): DispatchRecord {
    const record: DispatchRecord = {
      id: `d-${++s.counters.dispatch}`,
      at: now.toISOString(),
      strategy: plan.strategy,
      unitIds: plan.assignments.map((a) => a.unitId),
      rationale: plan.rationale,
    };
    for (const a of plan.assignments) {
      const u = findUnit(s, a.unitId);
      u.status = 'in_progress';
      u.claim = { at: record.at, executor: a.executor, isolation: a.isolation, dispatchId: record.id };
    }
    s.dispatches.push(record);
    logEvent(s, now, 'dispatch', `${record.id} ${plan.strategy}: ${record.unitIds.join(', ')}`);
    return record;
  }

  private dispatchView(s: SessionRecord, record: DispatchRecord, plan: ExecutionPlan): NonNullable<NextWorkResult['dispatch']> {
    const g = graphOf(s);
    return {
      dispatchId: record.id,
      strategy: plan.strategy,
      rationale: plan.rationale,
      assignments: plan.assignments.map((a) => ({
        executor: a.executor,
        isolation: a.isolation,
        unit: unitView(findUnit(s, a.unitId), g),
      })),
    };
  }

  private ensureValidationUnit(s: SessionRecord, now: Date, covers: string[]): WorkUnit {
    const acceptance = [
      ...s.phase.exitCriteria.map((c) => `Exit criterion: ${c}`),
      ...covers.flatMap((id) => findUnit(s, id).acceptance.map((a) => `${id}: ${a}`)),
      'Full test suite, build and lint pass on the integrated result.',
    ];
    const pending = s.units.find((u) => u.kind === 'validation' && u.status === 'pending');
    if (pending) {
      const all = [...new Set([...(pending.validates ?? []), ...covers])];
      pending.validates = all;
      pending.dependsOn = all;
      pending.acceptance = acceptance;
      return pending;
    }
    let n = ++s.counters.validation;
    while (s.units.some((u) => u.id === `validate-${n}`)) n = ++s.counters.validation;
    const unit: WorkUnit = {
      id: `validate-${n}`,
      title: `Integration validation #${n}`,
      description: `Verify ${covers.length} completed unit(s) together: ${covers.join(', ')}.`,
      kind: 'validation',
      status: 'pending',
      dependsOn: [...covers],
      decisionIds: [],
      priority: 'high',
      acceptance,
      touches: [],
      parallelSafe: false,
      addedLate: false,
      addedAt: now.toISOString(),
      attempts: 0,
      notes: [],
      validates: [...covers],
    };
    s.units.push(unit);
    logEvent(s, now, 'validation', `${unit.id} created for ${covers.join(', ')}`);
    return unit;
  }

  /** After a human changes decisions or the graph, re-derive a halted session's state. */
  private reclassifyHalted(s: SessionRecord, now: Date): void {
    if (!isHalted(s.state) || s.state === 'paused') return;
    const halt = classifyHalt(s);
    if (halt.state !== s.state) transition(s, halt.state, halt.message, now);
  }

  private async snapshot(root: string): Promise<ProjectSnapshot | undefined> {
    if (!this.inspector) return undefined;
    try {
      return await this.inspector.inspect(root);
    } catch {
      return undefined;
    }
  }

  private async load(id: string): Promise<SessionRecord> {
    const s = await this.repo.load(id);
    if (!s) fail('NOT_FOUND', `Unknown session '${id}'. Use list_sessions to find sessions.`);
    return s;
  }

  private async read<T>(id: string, fn: (s: SessionRecord, now: Date) => T): Promise<T> {
    const s = await this.load(id);
    return fn(s, this.clock.now());
  }

  private mutate<T>(id: string, fn: (s: SessionRecord, now: Date) => T | Promise<T>): Promise<T> {
    return this.locks.run(id, async () => {
      const s = await this.load(id);
      const expected = s.revision;
      const now = this.clock.now();
      const result = await fn(s, now);
      s.lastActivityAt = now.toISOString();
      s.updatedAt = s.lastActivityAt;
      await this.repo.save(s, expected);
      return result;
    });
  }
}

// ─── record helpers (mutate the record in place) ─────────────────────────────

function transition(s: SessionRecord, to: SessionState, reason: string, now: Date): void {
  assertTransition(s.state, to);
  const from = s.state;
  s.state = to;
  s.stateReason = reason;
  if (from !== to) logEvent(s, now, 'state', `${from} → ${to}: ${reason}`);

  // Autonomy budget ticks only while an OUTSIDE_MODE run is active.
  if (s.mode === 'outside' && isActive(to)) startClock(s.budget, now);
  else stopClock(s.budget, now);

  const open = s.runs.at(-1);
  const hasOpenRun = open !== undefined && open.endedAt === undefined;
  if (isActive(to) && !hasOpenRun) s.runs.push({ mode: s.mode, startedAt: now.toISOString() });
  if (!isActive(to) && hasOpenRun) closeRun(s, now, reason);
}

function closeRun(s: SessionRecord, at: Date, reason: string): void {
  const open = s.runs.at(-1);
  if (open && open.endedAt === undefined) {
    open.endedAt = at.toISOString();
    open.endReason = reason;
  }
}

function logEvent(s: SessionRecord, now: Date, type: string, message: string): void {
  s.events.push({ at: now.toISOString(), type, message });
}

function releaseUnit(u: WorkUnit, note: string): void {
  u.status = 'pending';
  u.claim = undefined;
  u.notes.push(note);
}

function hasInFlight(s: SessionRecord): boolean {
  return s.units.some((u) => u.status === 'in_progress');
}

function findUnit(s: SessionRecord, id: string): WorkUnit {
  return s.units.find((u) => u.id === id) ?? fail('NOT_FOUND', `Unknown unit '${id}'.`);
}

function assertNotTerminal(s: SessionRecord): void {
  if (isTerminal(s.state)) fail('SESSION_TERMINAL', `Session is ${s.state}; no further changes are accepted.`);
}

function canRecordDecisions(s: SessionRecord): boolean {
  if (isTerminal(s.state)) return false;
  return !(s.mode === 'outside' && isActive(s.state));
}

function newUnit(spec: UnitInput, iso: string, late: boolean): WorkUnit {
  const u: WorkUnit = {
    id: spec.id,
    title: spec.title!.trim(),
    kind: spec.kind ?? 'task',
    status: 'pending',
    dependsOn: [],
    decisionIds: [],
    priority: 'normal',
    acceptance: [],
    touches: [],
    parallelSafe: true,
    addedLate: late,
    addedAt: iso,
    attempts: 0,
    notes: [],
  };
  applyUnitSpec(u, spec);
  return u;
}

function applyUnitSpec(u: WorkUnit, spec: UnitInput): void {
  if (spec.title !== undefined && spec.title.trim()) u.title = spec.title.trim();
  if (spec.description !== undefined) u.description = spec.description;
  if (spec.kind !== undefined) u.kind = spec.kind;
  if (spec.dependsOn !== undefined) u.dependsOn = [...new Set(spec.dependsOn)];
  if (spec.decisionIds !== undefined) u.decisionIds = [...new Set(spec.decisionIds)];
  if (spec.estimateMinutes !== undefined) u.estimateMinutes = spec.estimateMinutes;
  if (spec.priority !== undefined) u.priority = spec.priority;
  if (spec.acceptance !== undefined) u.acceptance = [...spec.acceptance];
  if (spec.workstream !== undefined) u.workstream = spec.workstream || undefined;
  if (spec.touches !== undefined) u.touches = [...spec.touches];
  if (spec.parallelSafe !== undefined) u.parallelSafe = spec.parallelSafe;
  if (spec.rationale !== undefined) u.rationale = spec.rationale;
}

function executeGuidance(plan: ExecutionPlan): string {
  const main = plan.assignments.filter((a) => a.executor === 'main').map((a) => a.unitId);
  const subs = plan.assignments.filter((a) => a.executor === 'subagent').map((a) => a.unitId);
  if (subs.length === 0) {
    return (
      `Execute ${main.map((id) => `'${id}'`).join(', ')} yourself. Meet its acceptance criteria, run the relevant checks, ` +
      'then report_work with outcome completed and the validation evidence (or failed/blocked). ' +
      'If human judgment is needed, request_decision and move on; do not ask the user.'
    );
  }
  return (
    `Parallel dispatch. Execute ${main.map((id) => `'${id}'`).join(', ')} yourself. Spawn one subagent per unit in ` +
    `${subs.map((id) => `'${id}'`).join(', ')}, each in an isolated worktree, briefed with the unit's description, ` +
    'acceptance criteria and touched paths. Integrate their results, then report_work for every unit with its own validation evidence. ' +
    'You remain responsible for integration and final validation.'
  );
}

function stateGuidance(s: SessionRecord): string {
  switch (s.state) {
    case 'analyzing':
      return ANALYSIS_GUIDANCE;
    case 'planning':
    case 'running':
    case 'validating':
      return 'Active. Call next_work for the next dispatch; report_work after each unit.';
    case 'paused':
      return 'Paused. resume_session continues it.';
    case 'waiting_for_human':
      return 'Waiting for human decisions: get_decisions, record_decision, then resume_session.';
    case 'blocked':
      return 'Blocked: see get_handoff for blocked units and their causes; reopen them via update_work_graph once fixed.';
    case 'resumable':
      return 'Resumable: resume_session (optionally with addBudgetMinutes) continues from the handoff.';
    case 'completed':
      return 'Completed. get_session_report has the summary.';
    case 'failed':
      return 'Failed. get_session_report has the summary.';
    default:
      return '';
  }
}

/** Serializes async work per key. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export { DomainError };
