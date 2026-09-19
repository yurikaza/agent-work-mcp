/**
 * Regression tests for issues found in the v0.1 independent review.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionRepository } from '../src/adapters/persistence/file-repository.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { complete, drive, harness, startOutside, unit } from './helpers.js';

const failingValidation = { passed: false, checks: [{ name: 'e2e', passed: false }] };

describe('validation units cannot loop', () => {
  it('a permanently failing validation halts as blocked instead of spawning new validation units', async () => {
    const h = harness({ policy: { maxAttempts: 2 } });
    const sid = await startOutside(h.o, 600);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'a');

    for (let i = 0; i < 2; i++) {
      const v = await h.o.nextWork(sid);
      expect(v.dispatch?.assignments[0]?.unit.id).toBe('validate-1');
      await h.o.reportWork({ sessionId: sid, unitId: 'validate-1', outcome: 'completed', summary: 'red', validation: failingValidation });
    }
    const stop = await h.o.nextWork(sid);
    expect(stop).toMatchObject({ action: 'stop', stopReason: 'blocked', state: 'blocked' });
    const graph = await h.o.getWorkGraph({ sessionId: sid });
    expect(graph.units.filter((u) => u.kind === 'validation').map((u) => u.id)).toEqual(['validate-1']);
    expect((await h.o.getHandoff(sid)).nextActions.join('\n')).toMatch(/Investigate failed validate-1/);
  });

  it('a blocked validation halts as blocked; reopening it lets the session complete', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'a');
    await h.o.nextWork(sid);
    await h.o.reportWork({
      sessionId: sid,
      unitId: 'validate-1',
      outcome: 'blocked',
      summary: 'staging down',
      blocker: { kind: 'environment', detail: 'staging DB unreachable' },
    });
    const stop = await h.o.nextWork(sid);
    expect(stop).toMatchObject({ stopReason: 'blocked' });
    expect((await h.o.getWorkGraph({ sessionId: sid })).units.map((u) => u.id)).toEqual(['a', 'validate-1']);

    await h.o.updateWorkGraph({ sessionId: sid, reopen: [{ id: 'validate-1', note: 'staging is back' }] });
    await h.o.resumeSession({ sessionId: sid });
    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['validate-1']);
    expect(last.state).toBe('completed');
  });

  it('allows one wrap-up validation past the budget, not retries', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 30);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(40);
    await complete(h.o, sid, 'a');
    await h.o.nextWork(sid); // wrap-up validation
    await h.o.reportWork({ sessionId: sid, unitId: 'validate-1', outcome: 'completed', summary: 'red', validation: failingValidation });
    const stop = await h.o.nextWork(sid);
    expect(stop).toMatchObject({ action: 'stop', stopReason: 'budget_exhausted', state: 'resumable' });
  });

  it('validation units cannot be gated by decisions', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a')] });
    await h.o.nextWork(sid);
    await complete(h.o, sid, 'a');
    await h.o.nextWork(sid);
    await expect(
      h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: ['validate-1'] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('decision gates cannot be bypassed', () => {
  it('the autonomous agent cannot cancel work that waits on an open decision; a human can', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: ['b'] });
    await expect(
      h.o.updateWorkGraph({ sessionId: sid, cancel: [{ id: 'b', reason: 'not needed' }] }),
    ).rejects.toMatchObject({ code: 'DECISION_REQUIRES_HUMAN' });
    await drive(h, sid); // halts waiting_for_human
    const r = await h.o.updateWorkGraph({ sessionId: sid, cancel: [{ id: 'b', reason: 'human descoped it' }] });
    expect(r.cancelled).toEqual(['b']);
  });

  it('dependency edits stay visible in the unit notes', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b', { dependsOn: ['a'] })] });
    await h.o.updateWorkGraph({ sessionId: sid, units: [{ id: 'b', dependsOn: [] }] });
    const g = await h.o.getWorkGraph({ sessionId: sid });
    expect(g.units.find((u) => u.id === 'b')?.notes).toContain('Dependencies changed in graph r2: [a] → []');
  });

  it('update_work_graph cannot remove an open decision gate', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: ['b'] });
    await expect(
      h.o.updateWorkGraph({ sessionId: sid, units: [{ id: 'b', decisionIds: [] }] }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Editing other fields while keeping the gate is fine.
    await h.o.updateWorkGraph({ sessionId: sid, units: [{ id: 'b', estimateMinutes: 5, decisionIds: ['dec-1'] }] });
  });

  it('gates added through the graph are reflected in decision impact', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: ['a'] });
    await h.o.updateWorkGraph({ sessionId: sid, units: [{ id: 'b', decisionIds: ['dec-1'] }] });
    const q = await h.o.getDecisions({ sessionId: sid });
    expect(q.decisions[0]).toMatchObject({ affectedUnitIds: ['a', 'b'], blockingCount: 2 });
  });
});

describe('interrupted sessions', () => {
  async function diedAfterTenMinutes() {
    const h = harness();
    const sid = await startOutside(h.o, 600);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(10);
    await h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'progress', summary: 'x', checkpoint: 'cp' });
    h.clock.advanceMinutes(300); // agent died
    return { h, sid };
  }

  it('pause on a stale session charges only up to the last activity and keeps claims', async () => {
    const { h, sid } = await diedAfterTenMinutes();
    const { session } = await h.o.pauseSession({ sessionId: sid });
    expect(session.budget.usedMinutes).toBe(10);
    expect(session.inFlight.map((u) => u.unitId)).toEqual(['a']);
    expect(session.runs[0]?.endReason).toBe('interrupted');
  });

  it('stop on a stale session charges only up to the last activity and releases claims', async () => {
    const { h, sid } = await diedAfterTenMinutes();
    const { session } = await h.o.stopSession({ sessionId: sid, reason: 'human back' });
    expect(session.budget.usedMinutes).toBe(10);
    expect(session.inFlight).toEqual([]);
  });

  it('silence is charged unless an explicit recovery command comes first (never undercharge the bound)', async () => {
    const { h, sid } = await diedAfterTenMinutes();
    await h.o.updateWorkGraph({ sessionId: sid, units: [{ id: 'b', estimateMinutes: 5 }] });
    const { session } = await h.o.pauseSession({ sessionId: sid });
    expect(session.budget.usedMinutes).toBe(310);
  });

  it('an agent that worked silently and then raises a decision is charged for the work', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 600);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(90);
    await h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: ['a'], checkpoint: 'cp' });
    expect((await h.o.getSession(sid)).session.budget.usedMinutes).toBe(90);
  });

  it('recovery opens exactly one new run, labelled with the resumed mode', async () => {
    const { h, sid } = await diedAfterTenMinutes();
    const r = await h.o.resumeSession({ sessionId: sid, mode: 'desk' });
    expect(r.session.runs.map((x) => [x.mode, x.endReason ?? 'open'])).toEqual([
      ['outside', 'interrupted'],
      ['desk', 'open'],
    ]);
    const { h: h2, sid: sid2 } = await diedAfterTenMinutes();
    const p = await h2.o.pauseSession({ sessionId: sid2 });
    expect(p.session.runs).toHaveLength(1); // no zero-length run
  });

  it('a live agent that was silent while working keeps its claim and is charged for the time', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 600);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(90); // no estimate, no heartbeat: looks stale, but the agent is working
    const r = await complete(h.o, sid, 'a');
    expect(r.unit.status).toBe('done');
    expect((await h.o.getSession(sid)).session.budget.usedMinutes).toBe(90);
  });
});

describe('state classification edge cases', () => {
  it('a first graph submitted to a halted session is re-classified', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    const stopped = await h.o.stopSession({ sessionId: sid, reason: 'interrupted during analysis' });
    expect(stopped.session.state).toBe('resumable');
    const r = await h.o.updateWorkGraph({ sessionId: sid, units: [] });
    expect(r.state).toBe('completed');
  });

  it('analysis does not run past the budget', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 30);
    h.clock.advanceMinutes(45);
    const next = await h.o.nextWork(sid);
    expect(next).toMatchObject({ action: 'stop', stopReason: 'budget_exhausted', state: 'resumable' });
  });

  it('a halted session keeps its specific reason when re-classification does not change the state', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 30);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b'), unit('c')] });
    h.clock.advanceMinutes(45);
    const stop = await h.o.nextWork(sid);
    expect(stop.state).toBe('resumable');
    await h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: ['c'] });
    expect((await h.o.getSession(sid)).session.stateReason).toMatch(/Budget exhausted/);
  });

  it('concurrent start_session calls on one project cannot both succeed', async () => {
    const h = harness();
    const results = await Promise.allSettled([startOutside(h.o), startOutside(h.o)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

describe('file repository robustness', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-work-reg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('separate processes cannot both start a session on one project', async () => {
    const state = join(dir, 'state');
    // Independent orchestrators and repositories stand in for separate server processes.
    const make = () => new Orchestrator({ repository: new FileSessionRepository(state), defaultProjectRoot: dir });
    for (let round = 0; round < 5; round++) {
      const root = join(dir, `project-${round}`);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => make().startSession({ mode: 'outside', goal: 'g', budgetMinutes: 60, projectRoot: root })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        expect(r.reason).toMatchObject({ code: 'SESSION_CONFLICT' });
      }
    }
  });

  it('many concurrent writers at one revision: exactly one wins every round', async () => {
    const state = join(dir, 'state');
    const o = new Orchestrator({ repository: new FileSessionRepository(state), defaultProjectRoot: dir });
    const { session } = await o.startSession({ mode: 'desk', goal: 'g' });
    for (let round = 0; round < 10; round++) {
      const repos = Array.from({ length: 8 }, () => new FileSessionRepository(state));
      const copies = await Promise.all(repos.map((r) => r.load(session.sessionId)));
      const results = await Promise.allSettled(
        copies.map((c, i) => {
          c!.handoffNotes.push(`writer ${i}`);
          return repos[i]!.save(c!, c!.revision);
        }),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    }
    const final = (await new FileSessionRepository(state).load(session.sessionId))!;
    expect(final.revision).toBe(11);
    expect(final.handoffNotes).toHaveLength(10);
  });

  it('two writers at the same revision: exactly one wins, the other gets CONFLICT', async () => {
    const state = join(dir, 'state');
    const o = new Orchestrator({ repository: new FileSessionRepository(state), defaultProjectRoot: dir });
    const { session } = await o.startSession({ mode: 'desk', goal: 'g' });
    // Two independent repository instances stand in for two processes.
    const r1 = new FileSessionRepository(state);
    const r2 = new FileSessionRepository(state);
    const a = (await r1.load(session.sessionId))!;
    const b = (await r2.load(session.sessionId))!;
    a.handoffNotes.push('from A');
    b.handoffNotes.push('from B');
    const results = await Promise.allSettled([r1.save(a, a.revision), r2.save(b, b.revision)]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(winners).toHaveLength(1);
    expect(losers[0]?.reason).toMatchObject({ code: 'CONFLICT' });
    const stored = (await r1.load(session.sessionId))!;
    expect(stored.handoffNotes).toHaveLength(1);
    expect(stored.revision).toBe(2);
  });

  it('one corrupt session file does not break listing or starting sessions', async () => {
    const state = join(dir, 'state');
    const o = new Orchestrator({ repository: new FileSessionRepository(state), defaultProjectRoot: dir });
    await o.startSession({ mode: 'desk', goal: 'first', projectRoot: join(dir, 'p1') });
    await mkdir(join(state, 'sessions', 'ses_corrupt'), { recursive: true });
    await writeFile(join(state, 'sessions', 'ses_corrupt', '1.json'), '{ not json');
    await o.startSession({ mode: 'desk', goal: 'second', projectRoot: join(dir, 'p2') });
    expect((await o.listSessions()).sessions.map((s) => s.goal).sort()).toEqual(['first', 'second']);
  });
});
