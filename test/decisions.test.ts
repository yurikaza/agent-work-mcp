import { describe, expect, it } from 'vitest';
import { complete, drive, harness, startOutside, unit } from './helpers.js';

async function setup() {
  const h = harness();
  const sid = await startOutside(h.o, 480);
  await h.o.updateWorkGraph({
    sessionId: sid,
    units: [
      unit('auth-core'),
      unit('auth-ui', { dependsOn: ['auth-core'] }),
      unit('billing'),
      unit('billing-ui', { dependsOn: ['billing'] }),
      unit('logging'),
    ],
  });
  return { h, sid };
}

const question = {
  question: 'Session tokens: JWT or opaque server sessions?',
  whyItMatters: 'Determines revocation, storage and every auth endpoint; expensive to change later.',
  category: 'architecture' as const,
  options: [{ label: 'JWT' }, { label: 'Opaque sessions', consequences: 'needs Redis' }],
  recommendation: 'Opaque sessions: revocation is a stated requirement.',
};

describe('decision queue in OUTSIDE_MODE', () => {
  it('queues the decision, gates affected + dependent work, and continues independent work', async () => {
    const { h, sid } = await setup();
    const r = await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });

    expect(r.decision).toMatchObject({ id: 'dec-1', status: 'open', blockingCount: 2, raisedInMode: 'outside' });
    expect(r.decision.blockedUnitIds.sort()).toEqual(['auth-core', 'auth-ui']);
    expect(r.decision.independentReadyUnitIds.sort()).toEqual(['billing', 'logging']);
    expect(r.decision.options.map((o) => o.id)).toEqual(['opt-1', 'opt-2']);
    expect(r.state).not.toBe('waiting_for_human');
    expect(r.guidance).toMatch(/keep going/);

    // The run continues with everything the decision does not touch.
    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['billing', 'billing-ui', 'logging', 'validate-1']);
    expect(last).toMatchObject({ action: 'stop', stopReason: 'waiting_for_human', state: 'waiting_for_human' });

    const handoff = await h.o.getHandoff(sid);
    expect(handoff.decisionsNeeded.map((d) => d.id)).toEqual(['dec-1']);
    expect(handoff.nextActions[0]).toMatch(/^Decide dec-1/);
    expect(handoff.markdown).toMatch(/Agent suggestion \(not applied\): Opaque sessions/);
    expect(handoff.blocked.find((u) => u.id === 'auth-ui')?.rootCauses).toEqual(['decision:dec-1']);
  });

  it('never lets the autonomous agent record a decision', async () => {
    const { h, sid } = await setup();
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });
    await h.o.nextWork(sid); // running
    await expect(
      h.o.recordDecision({ sessionId: sid, decisionId: 'dec-1', choice: 'JWT', decidedBy: 'agent' }),
    ).rejects.toMatchObject({ code: 'DECISION_REQUIRES_HUMAN' });
    const q = await h.o.getDecisions({ sessionId: sid });
    expect(q.canRecordDecisions).toBe(false);
    expect(q.decisions[0]?.status).toBe('open');
  });

  it('releases an in-progress unit that turns out to need a decision, keeping its checkpoint', async () => {
    const { h, sid } = await setup();
    const d = await h.o.nextWork(sid);
    const current = d.dispatch!.assignments[0]!.unit.id;
    expect(current).toBe('auth-core');
    const r = await h.o.requestDecision({
      sessionId: sid,
      ...question,
      affectedUnitIds: ['auth-core'],
      checkpoint: 'User model done; token issuing depends on dec-1',
    });
    expect(r.releasedUnitIds).toEqual(['auth-core']);
    expect(r.state).toBe('planning');
    const graph = await h.o.getWorkGraph({ sessionId: sid, filter: 'remaining' });
    expect(graph.units.find((u) => u.id === 'auth-core')).toMatchObject({
      status: 'pending',
      readiness: 'waiting_on_decision',
      checkpoint: 'User model done; token issuing depends on dec-1',
    });
    const next = await h.o.nextWork(sid);
    expect(next.dispatch?.assignments[0]?.unit.id).not.toBe('auth-core');
  });

  it('only halts when every remaining unit depends on open decisions', async () => {
    const { h, sid } = await setup();
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });
    await h.o.requestDecision({
      sessionId: sid,
      question: 'Which payment provider?',
      whyItMatters: 'Contract and fees',
      category: 'product',
      affectedUnitIds: ['billing'],
    });
    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['logging', 'validate-1']);
    expect(last.stopReason).toBe('waiting_for_human');
  });

  it('advisory decisions (no affected units) never block completion', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.requestDecision({ sessionId: sid, question: 'Rename the package later?', whyItMatters: 'Branding' });
    const { last } = await drive(h, sid);
    expect(last.state).toBe('completed');
    const report = await h.o.getReport(sid);
    expect(report.decisions.open).toEqual([{ id: 'dec-1', question: 'Rename the package later?', blockingCount: 0 }]);
  });

  it('orders the queue by how much work each decision blocks', async () => {
    const { h, sid } = await setup();
    await h.o.requestDecision({ sessionId: sid, question: 'Log format?', whyItMatters: 'ops', affectedUnitIds: ['logging'] });
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });
    const q = await h.o.getDecisions({ sessionId: sid });
    expect(q.decisions.map((d) => [d.id, d.blockingCount])).toEqual([
      ['dec-2', 2],
      ['dec-1', 1],
    ]);
  });

  it('rejects gating finished work', async () => {
    const { h, sid } = await setup();
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'auth-core');
    await expect(
      h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('resolving decisions in DESK_MODE and resuming', () => {
  it('human resolves after the run halts; work unblocks; resume continues from the handoff', async () => {
    const { h, sid } = await setup();
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });
    await drive(h, sid);
    expect((await h.o.getSession(sid)).session.state).toBe('waiting_for_human');

    const q = await h.o.getDecisions({ sessionId: sid });
    expect(q.canRecordDecisions).toBe(true);
    const resolved = await h.o.recordDecision({
      sessionId: sid,
      decisionId: 'dec-1',
      choice: 'Opaque sessions',
      rationale: 'Revocation required',
      decidedBy: 'Yusuf',
    });
    expect(resolved.state).toBe('resumable');
    expect(resolved.unblockedUnitIds).toEqual(['auth-core']);
    expect(resolved.decision.resolution).toMatchObject({ choice: 'Opaque sessions', decidedBy: 'Yusuf' });
    await expect(
      h.o.recordDecision({ sessionId: sid, decisionId: 'dec-1', choice: 'JWT', decidedBy: 'Yusuf' }),
    ).rejects.toMatchObject({ code: 'DECISION_NOT_OPEN' });

    // Hand back to autonomy. The executing agent sees the human's answer on the unit.
    const resumed = await h.o.resumeSession({ sessionId: sid, mode: 'outside' });
    expect(resumed.session.state).toBe('planning');
    const next = await h.o.nextWork(sid);
    const dispatched = next.dispatch!.assignments[0]!.unit;
    expect(dispatched.id).toBe('auth-core');
    expect(dispatched.notes.join('\n')).toMatch(/Decision dec-1 resolved by Yusuf: Opaque sessions — Revocation required/);

    await complete(h.o, sid, 'auth-core');
    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['auth-ui', 'validate-2']);
    expect(last.state).toBe('completed');
    const report = await h.o.getReport(sid);
    expect(report.decisions).toMatchObject({ raised: 1, resolved: 1, open: [] });
    expect(report.runs).toHaveLength(2);
  });

  it('a human in DESK_MODE can resolve while a desk run is active', async () => {
    const h = harness();
    const r = await h.o.startSession({ mode: 'desk', goal: 'Auth', projectRoot: '/tmp/desk' });
    const sid = r.session.sessionId;
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['b'] });
    await h.o.nextWork(sid);
    const res = await h.o.recordDecision({ sessionId: sid, decisionId: 'dec-1', choice: 'JWT', decidedBy: 'Yusuf' });
    expect(res.state).toBe('running');
  });

  it('pausing an OUTSIDE run hands decisions to the human', async () => {
    const { h, sid } = await setup();
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });
    await h.o.pauseSession({ sessionId: sid, reason: 'human is back' });
    const res = await h.o.recordDecision({ sessionId: sid, decisionId: 'dec-1', choice: 'JWT', decidedBy: 'Yusuf' });
    expect(res.state).toBe('paused');
  });

  it('withdrawing a question releases its gates', async () => {
    const { h, sid } = await setup();
    await h.o.requestDecision({ sessionId: sid, ...question, affectedUnitIds: ['auth-core'] });
    await drive(h, sid);
    const res = await h.o.recordDecision({ sessionId: sid, decisionId: 'dec-1', withdraw: true, decidedBy: 'Yusuf' });
    expect(res.decision.status).toBe('withdrawn');
    expect(res.state).toBe('resumable');
    await expect(
      h.o.recordDecision({ sessionId: sid, decisionId: 'dec-9', choice: 'x', decidedBy: 'Yusuf' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
