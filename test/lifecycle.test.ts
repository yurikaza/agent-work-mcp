import { describe, expect, it } from 'vitest';
import { byId, complete, drive, harness, passing, startOutside, unit } from './helpers.js';

describe('session start', () => {
  it('requires a budget for OUTSIDE_MODE and starts analyzing', async () => {
    const { o } = harness();
    await expect(o.startSession({ mode: 'outside', goal: 'x' })).rejects.toMatchObject({ code: 'BUDGET_REQUIRED' });

    const r = await o.startSession({ mode: 'outside', goal: 'Ship phase 1', budgetMinutes: 120, projectRoot: '/tmp/project' });
    expect(r.session.state).toBe('analyzing');
    expect(r.session.budget).toMatchObject({ totalMinutes: 120, clockRunning: true });
    expect(r.snapshot?.docs).toContain('README.md');
    expect(r.guidance).toMatch(/update_work_graph/);

    const next = await o.nextWork(r.session.sessionId);
    expect(next.action).toBe('plan');
  });

  it('refuses a second active session on the same project', async () => {
    const { o } = harness();
    await startOutside(o);
    await expect(startOutside(o)).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
  });
});

describe('OUTSIDE_MODE execution loop', () => {
  it('continues after each completed unit, validates, and completes', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 240, { exitCriteria: ['API documented'] });
    const g = await h.o.updateWorkGraph({
      sessionId: sid,
      units: [unit('schema'), unit('api', { dependsOn: ['schema'] }), unit('docs', { dependsOn: ['api'] })],
      projectContext: { summary: 'Node service', commands: { test: 'npm test' } },
    });
    expect(g.state).toBe('planning');
    expect(g.readyUnitIds).toEqual(['schema']);

    const first = await h.o.nextWork(sid);
    expect(first.action).toBe('execute');
    expect(first.state).toBe('running');
    expect(first.dispatch?.strategy).toBe('direct');
    expect(first.dispatch?.assignments.map((a) => a.unit.id)).toEqual(['schema']);

    h.clock.advanceMinutes(20);
    const reported = await complete(h.o, sid, 'schema');
    // A single completed task never ends the session.
    expect(reported.state).toBe('planning');
    expect(reported.guidance).toMatch(/does not end the session/);
    expect(reported.newlyReadyUnitIds).toEqual(['api']);

    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['api', 'docs', 'validate-1']);
    expect(last).toMatchObject({ action: 'stop', stopReason: 'completed', state: 'completed' });

    const graph = await h.o.getWorkGraph({ sessionId: sid });
    const validation = byId(graph.units, 'validate-1');
    expect(validation.kind).toBe('validation');
    expect(validation.acceptance).toContain('Exit criterion: API documented');
    expect(graph.units.filter((u) => u.kind === 'task').every((u) => u.validatedBy === 'validate-1')).toBe(true);

    const report = await h.o.getReport(sid);
    expect(report.outcome).toBe('completed');
    expect(report.completed).toHaveLength(4);
    expect(report.budget.usedMinutes).toBe(50);
    expect(report.budget.unusedReason).toMatch(/intentionally left unused/);
  });

  it('enters validating while the integration check runs', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('only')] });
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'only');
    const v = await h.o.nextWork(sid);
    expect(v.state).toBe('validating');
    expect(v.dispatch?.assignments[0]?.unit.kind).toBe('validation');
    expect((await h.o.getSession(sid)).session.state).toBe('validating');
  });

  it('does not invent work when the graph is empty', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 480);
    await h.o.updateWorkGraph({ sessionId: sid, units: [], projectContext: { summary: 'Nothing left for this phase.' } });
    const next = await h.o.nextWork(sid);
    expect(next).toMatchObject({ action: 'stop', stopReason: 'completed', state: 'completed' });
    const report = await h.o.getReport(sid);
    expect(report.completed).toHaveLength(0);
    expect(report.budget.remainingMinutes).toBe(480);
  });

  it('a short task finishes quickly and the next meaningful work is identified', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 300);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [unit('quick', { estimateMinutes: 20 }), unit('long', { estimateMinutes: 240, dependsOn: ['quick'] })],
    });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(20);
    await complete(h.o, sid, 'quick');
    const next = await h.o.nextWork(sid);
    expect(next.dispatch?.assignments[0]?.unit.id).toBe('long');
    expect(next.budget.usedMinutes).toBe(20);
  });

  it('lets a genuinely long unit use most of the budget', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 300);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('migration', { estimateMinutes: 240 })] });
    const next = await h.o.nextWork(sid);
    expect(next.action).toBe('execute');
    h.clock.advanceMinutes(235);
    await complete(h.o, sid, 'migration');
    const v = await h.o.nextWork(sid);
    expect(v.dispatch?.assignments[0]?.unit.kind).toBe('validation');
  });

  it('halts as resumable when no ready unit fits the remaining budget', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 60);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [unit('small', { estimateMinutes: 30 }), unit('huge', { estimateMinutes: 240 })],
    });
    const { executed, last } = await drive(h, sid, 10);
    expect(executed).toEqual(['small', 'validate-1']);
    expect(last).toMatchObject({ action: 'stop', stopReason: 'budget_insufficient', state: 'resumable' });
    const handoff = await h.o.getHandoff(sid);
    expect(handoff.readyNext.map((u) => u.id)).toEqual(['huge']);
    expect(handoff.nextActions.join('\n')).toMatch(/addBudgetMinutes/);
  });

  it('stops on budget exhaustion after validating, and resumes with more budget', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 60);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b'), unit('c')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(70); // overran the whole budget on one unit
    await complete(h.o, sid, 'a');

    const v = await h.o.nextWork(sid);
    expect(v.dispatch?.assignments[0]?.unit.kind).toBe('validation'); // wrap-up validation is always allowed
    await complete(h.o, sid, 'validate-1');
    const stop = await h.o.nextWork(sid);
    expect(stop).toMatchObject({ action: 'stop', stopReason: 'budget_exhausted', state: 'resumable' });

    await expect(h.o.resumeSession({ sessionId: sid })).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    const resumed = await h.o.resumeSession({ sessionId: sid, addBudgetMinutes: 60 });
    expect(resumed.session.state).toBe('planning');
    expect(resumed.session.runs).toHaveLength(2);
    const { executed } = await drive(h, sid);
    expect(executed).toEqual(['b', 'c', 'validate-2']);
  });

  it('asks the agent to finish in-flight work when budget runs out mid-flight', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 60);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [
        unit('a', { estimateMinutes: 50, touches: ['src/a'] }),
        unit('b', { estimateMinutes: 50, touches: ['src/b'] }),
      ],
    });
    const d = await h.o.nextWork(sid);
    expect(d.dispatch?.strategy).toBe('parallel');
    h.clock.advanceMinutes(65);
    await complete(h.o, sid, 'a');
    const wait = await h.o.nextWork(sid);
    expect(wait.action).toBe('wait');
    expect(wait.guidance).toMatch(/budget is exhausted/i);
  });
});

describe('parallel execution', () => {
  it('dispatches isolated large units to main + subagent and integrates before validation', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 480);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [
        unit('backend', { estimateMinutes: 90, touches: ['server/'] }),
        unit('frontend', { estimateMinutes: 60, touches: ['web/'] }),
        unit('e2e', { estimateMinutes: 30, dependsOn: ['backend', 'frontend'] }),
      ],
    });
    const next = await h.o.nextWork(sid);
    expect(next.dispatch?.strategy).toBe('parallel');
    expect(next.dispatch?.assignments.map((a) => [a.unit.id, a.executor])).toEqual([
      ['backend', 'main'],
      ['frontend', 'subagent'],
    ]);
    expect(next.guidance).toMatch(/Spawn one subagent/);

    // Main agent finishes first; subagent still running → nothing isolated to add → wait.
    await complete(h.o, sid, 'backend');
    expect((await h.o.nextWork(sid)).action).toBe('wait');
    await complete(h.o, sid, 'frontend');
    const { executed } = await drive(h, sid);
    expect(executed).toEqual(['e2e', 'validate-1']);
    const report = await h.o.getReport(sid);
    expect(report.dispatches.parallel).toBe(1);
    expect(report.dispatches.parallelRationale[0]).toMatch(/isolated/);
  });

  it('executes small or shared work directly', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [unit('a', { estimateMinutes: 15, touches: ['a'] }), unit('b', { estimateMinutes: 15, touches: ['b'] })],
    });
    const next = await h.o.nextWork(sid);
    expect(next.dispatch?.strategy).toBe('direct');
    expect(next.dispatch?.assignments).toHaveLength(1);
  });
});

describe('validation and failure handling', () => {
  it('rejects completion without evidence', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    await expect(h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'completed', summary: 'trust me' })).rejects.toMatchObject({
      code: 'VALIDATION_REQUIRED',
    });
    await expect(
      h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'completed', summary: 'x', validation: { passed: true, checks: [] } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_REQUIRED' });
    const ok = await h.o.reportWork({
      sessionId: sid,
      unitId: 'a',
      outcome: 'completed',
      summary: 'docs only',
      validation: { passed: true, checks: [], notApplicableReason: 'Pure documentation change.' },
    });
    expect(ok.unit.status).toBe('done');
  });

  it('counts failing checks as a failed attempt and fails the unit after max attempts', async () => {
    const h = harness({ policy: { maxAttempts: 2 } });
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('flaky'), unit('after', { dependsOn: ['flaky'] }), unit('other')] });

    const d1 = await h.o.nextWork(sid);
    expect(d1.dispatch?.assignments[0]?.unit.id).toBe('flaky');
    const r1 = await h.o.reportWork({
      sessionId: sid,
      unitId: 'flaky',
      outcome: 'completed',
      summary: 'tests red',
      validation: { passed: true, checks: [{ name: 'unit tests', passed: false }] },
    });
    expect(r1.unit).toMatchObject({ status: 'pending', attempts: 1 });

    await h.o.nextWork(sid);
    const r2 = await h.o.reportWork({ sessionId: sid, unitId: 'flaky', outcome: 'failed', summary: 'still red' });
    expect(r2.unit.status).toBe('failed');

    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['other', 'validate-1']);
    expect(last).toMatchObject({ stopReason: 'blocked', state: 'blocked' });

    const handoff = await h.o.getHandoff(sid);
    expect(handoff.blocked.find((u) => u.id === 'after')?.rootCauses).toEqual(['failure:flaky']);

    // Human fixes the cause and reopens the unit.
    const reopened = await h.o.updateWorkGraph({ sessionId: sid, reopen: [{ id: 'flaky', note: 'fixed CI env' }] });
    expect(reopened.state).toBe('resumable');
    await h.o.resumeSession({ sessionId: sid });
    const rest = await drive(h, sid);
    expect(rest.executed).toEqual(['flaky', 'after', 'validate-2']);
    expect(rest.last.state).toBe('completed');
  });

  it('runs fix units before re-running a failed integration validation', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('feature')] });
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'feature');
    await h.o.nextWork(sid); // validate-1
    const failed = await h.o.reportWork({
      sessionId: sid,
      unitId: 'validate-1',
      outcome: 'completed',
      summary: 'lint fails',
      validation: { passed: false, checks: [{ name: 'lint', passed: false }] },
    });
    expect(failed.guidance).toMatch(/Add fix units/);

    await expect(h.o.updateWorkGraph({ sessionId: sid, units: [unit('fix-lint')] })).rejects.toMatchObject({
      code: 'RATIONALE_REQUIRED',
    });
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('fix-lint', { rationale: 'validate-1 lint failure' })] });

    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['fix-lint', 'validate-1']);
    expect(last.state).toBe('completed');
    const graph = await h.o.getWorkGraph({ sessionId: sid });
    expect(byId(graph.units, 'validate-1').validates).toEqual(['feature', 'fix-lint']);
    const report = await h.o.getReport(sid);
    expect(report.scopeAddedMidSession).toEqual([{ id: 'fix-lint', title: 'Do fix-lint', rationale: 'validate-1 lint failure' }]);
    expect(report.validation).toMatchObject({ passed: 1, failedAttempts: 1 });
  });

  it('records external blockers and continues independent work', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('deploy'), unit('refactor')] });
    await h.o.nextWork(sid);
    const r = await h.o.reportWork({
      sessionId: sid,
      unitId: 'deploy',
      outcome: 'blocked',
      summary: 'no credentials',
      blocker: { kind: 'access', detail: 'Staging deploy key missing' },
    });
    expect(r.unit.status).toBe('blocked');
    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['refactor', 'validate-1']);
    expect(last.stopReason).toBe('blocked');
    expect((await h.o.getHandoff(sid)).nextActions[0]).toMatch(/Unblock deploy: Staging deploy key missing/);
  });
});

describe('graph updates', () => {
  it('rejects invalid updates atomically', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await expect(
      h.o.updateWorkGraph({ sessionId: sid, units: [unit('a', { dependsOn: ['b'] }), unit('b', { dependsOn: ['a'] })] }),
    ).rejects.toMatchObject({ code: 'GRAPH_INVALID' });
    const s = await h.o.getSession(sid);
    expect(s.session).toMatchObject({ state: 'analyzing', graphSubmitted: false, counts: { total: 0 } });
  });

  it('protects done and validation units', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'a');
    await expect(h.o.updateWorkGraph({ sessionId: sid, units: [unit('a', { title: 'redo' })] })).rejects.toMatchObject({
      code: 'UNIT_IMMUTABLE',
    });
    await expect(h.o.updateWorkGraph({ sessionId: sid, cancel: [{ id: 'a', reason: 'x' }] })).rejects.toMatchObject({
      code: 'UNIT_IMMUTABLE',
    });
  });

  it('only claimed units can be reported', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await expect(complete(h.o, sid, 'a')).rejects.toMatchObject({ code: 'UNIT_NOT_CLAIMED' });
  });
});

describe('pause, resume, stop, interruption', () => {
  it('pause stops the budget clock and keeps claims; resume restores running', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 120);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(10);
    const paused = await h.o.pauseSession({ sessionId: sid, reason: 'lunch', notes: ['halfway through a'] });
    expect(paused.session).toMatchObject({ state: 'paused', budget: { usedMinutes: 10, clockRunning: false } });
    expect(paused.session.inFlight.map((u) => u.unitId)).toEqual(['a']);

    h.clock.advanceMinutes(600);
    expect((await h.o.nextWork(sid)).stopReason).toBe('paused');
    const resumed = await h.o.resumeSession({ sessionId: sid });
    expect(resumed.session).toMatchObject({ state: 'running', budget: { usedMinutes: 10 } });
    expect(resumed.handoff.notes).toEqual(['halfway through a']);
    await complete(h.o, sid, 'a');
  });

  it('recovers an interrupted session: budget closed at last activity, in-flight released with checkpoint', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 240);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a', { estimateMinutes: 30 }), unit('b')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(15);
    await h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'progress', summary: 'half', checkpoint: 'schema written, handler TODO' });

    // Agent process dies. Shortly after, another agent tries to resume.
    h.clock.advanceMinutes(5);
    await expect(h.o.resumeSession({ sessionId: sid })).rejects.toMatchObject({ code: 'SESSION_ACTIVE' });
    expect((await h.o.getSession(sid)).session.liveness).toBe('active');

    h.clock.advanceMinutes(120);
    expect((await h.o.getSession(sid)).session.liveness).toBe('stale');
    const resumed = await h.o.resumeSession({ sessionId: sid });
    expect(resumed.recoveredFromInterruption).toBe(true);
    expect(resumed.releasedUnitIds).toEqual(['a']);
    // 15 minutes of real activity; the 125 idle minutes after the crash are not charged.
    expect(resumed.session.budget.usedMinutes).toBe(15);
    expect(resumed.session.runs[0]?.endReason).toBe('interrupted');
    const redo = await h.o.nextWork(sid);
    expect(redo.dispatch?.assignments[0]?.unit).toMatchObject({ id: 'a', checkpoint: 'schema written, handler TODO' });
  });

  it('takeover resumes a session that still looks active', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    const r = await h.o.resumeSession({ sessionId: sid, takeover: true, mode: 'desk' });
    expect(r.session).toMatchObject({ state: 'planning', mode: 'desk' });
    expect(r.releasedUnitIds).toEqual(['a']);
  });

  it('stop releases in-flight work, classifies, and reports; markFailed is terminal', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.nextWork(sid);
    const stopped = await h.o.stopSession({ sessionId: sid, reason: 'user needs the machine', notes: ['a half done'] });
    expect(stopped.session.state).toBe('resumable');
    expect(stopped.session.inFlight).toEqual([]);
    expect(stopped.report.markdown).toMatch(/# Session report/);

    const failed = await h.o.stopSession({ sessionId: sid, reason: 'goal abandoned', markFailed: true });
    expect(failed.session.state).toBe('failed');
    await expect(h.o.resumeSession({ sessionId: sid })).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });
    await expect(h.o.updateWorkGraph({ sessionId: sid, units: [unit('c')] })).rejects.toMatchObject({ code: 'SESSION_TERMINAL' });
  });
});

describe('DESK_MODE', () => {
  it('runs sequentially and consumes no autonomous budget', async () => {
    const h = harness();
    const r = await h.o.startSession({ mode: 'desk', goal: 'Pair on auth', projectRoot: '/tmp/desk' });
    const sid = r.session.sessionId;
    expect(r.session.budget.clockRunning).toBe(false);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [unit('a', { estimateMinutes: 120, touches: ['a'] }), unit('b', { estimateMinutes: 120, touches: ['b'] })],
    });
    const next = await h.o.nextWork(sid);
    expect(next.dispatch?.assignments).toHaveLength(1);
    expect((await h.o.nextWork(sid)).action).toBe('wait');
    h.clock.advanceMinutes(500);
    await h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'completed', summary: 'ok', validation: passing() });
    expect((await h.o.getSession(sid)).session.budget.usedMinutes).toBe(0);
  });
});
