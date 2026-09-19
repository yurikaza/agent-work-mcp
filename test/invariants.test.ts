/**
 * Lifecycle invariants under random operation sequences, plus targeted checks of
 * the core guarantees: a finished unit never ends a session, decisions only block
 * dependent work, the budget is session-level, and parallelism is policy-driven.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/core/errors.js';
import { fitsBudget, remainingMinutes } from '../src/core/model/budget.js';
import type { SessionRecord } from '../src/core/model/session.js';
import { isActive, isHalted, isTerminal } from '../src/core/model/state-machine.js';
import { GraphIndex } from '../src/core/model/work-graph.js';
import { complete, drive, harness, passing, startOutside, unit } from './helpers.js';

/** Small deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(next() * xs.length)] : undefined),
    chance: (p: number) => next() < p,
  };
}

function checkRecord(s: SessionRecord, now: Date, trail: string[]): void {
  const where = `after: ${trail.slice(-8).join(' ')}`;
  const clockShouldRun = s.mode === 'outside' && isActive(s.state);
  expect(s.budget.activeSince !== null, `budget clock (${s.state}/${s.mode}) ${where}`).toBe(clockShouldRun);

  const openRun = s.runs.length > 0 && s.runs.at(-1)!.endedAt === undefined;
  expect(openRun, `open run vs state ${s.state} ${where}`).toBe(isActive(s.state));

  const inFlight = s.units.filter((u) => u.status === 'in_progress');
  if (inFlight.length > 0) {
    expect(isActive(s.state) || s.state === 'paused', `claims in ${s.state} ${where}`).toBe(true);
  }
  expect(inFlight.filter((u) => u.claim?.executor === 'main').length, `main holds >1 ${where}`).toBeLessThanOrEqual(1);

  const liveValidations = s.units.filter((u) => u.kind === 'validation' && !['done', 'cancelled'].includes(u.status));
  expect(liveValidations.length, `validation units ${where}`).toBeLessThanOrEqual(1);

  expect(remainingMinutes(s.budget, now) <= s.budget.totalMinutes, where).toBe(true);
}

const OPS = ['next', 'next', 'next', 'report', 'report', 'report', 'decide?', 'decide!', 'add', 'cancel', 'reopen', 'pause', 'resume', 'stop', 'time'] as const;

describe('random lifecycle invariants', () => {
  it.each(Array.from({ length: 120 }, (_, i) => i + 1))('seed %i', async (seed) => {
    const r = rng(seed);
    const h = harness({ policy: { maxAttempts: 2 } });
    const sid = await startOutside(h.o, 60 + r.int(300));
    const ids = ['a', 'b', 'c', 'd', 'e'];
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: ids.map((id, i) =>
        unit(id, {
          estimateMinutes: r.chance(0.7) ? 5 + r.int(90) : undefined,
          touches: r.chance(0.7) ? [`src/${id}`] : [],
          dependsOn: i > 0 && r.chance(0.4) ? [ids[r.int(i)]!] : [],
        }),
      ),
    });

    const trail: string[] = [];
    let terminalState: string | undefined;
    let added = 0;
    for (let step = 0; step < 60; step++) {
      const op = r.pick(OPS)!;
      trail.push(op);
      const before = (await h.repo.load(sid))!;
      try {
        switch (op) {
          case 'next': {
            const res = await h.o.nextWork(sid);
            const after = (await h.repo.load(sid))!;
            const g = new GraphIndex(after.units, after.decisions);
            if (res.action === 'execute') {
              for (const a of res.dispatch!.assignments) {
                // Decisions only gate their own units: nothing dispatched has an open gate or unfinished dependency.
                expect(a.unit.decisionIds.filter((d) => after.decisions.find((x) => x.id === d)?.status === 'open')).toEqual([]);
                for (const dep of a.unit.dependsOn) expect(g.get(dep)?.status).toBe('done');
                // Task units only start when they fit the session budget; the estimate itself is never a limit.
                if (after.mode === 'outside' && a.unit.kind === 'task') {
                  expect(fitsBudget(a.unit.estimateMinutes, remainingMinutes(after.budget, h.clock.now()), h.o.policy)).toBe(true);
                }
              }
            }
            if (res.action === 'stop' && isActive(before.state)) {
              // A run never stops while fitting executable work exists, unless the budget is spent.
              if (res.stopReason !== 'budget_exhausted') {
                const fitting = g
                  .ready()
                  .filter((u) => u.kind === 'task')
                  .filter((u) => after.mode !== 'outside' || fitsBudget(u.estimateMinutes, remainingMinutes(after.budget, h.clock.now()), h.o.policy));
                expect(fitting.map((u) => u.id), `stopped (${res.stopReason}) with work ${trail.join(' ')}`).toEqual([]);
              }
              if (res.stopReason === 'waiting_for_human') {
                expect(after.decisions.some((d) => d.status === 'open')).toBe(true);
              }
            }
            break;
          }
          case 'report': {
            const u = r.pick(before.units.filter((x) => x.status === 'in_progress'));
            if (!u) break;
            const kind = r.pick(['ok', 'ok', 'ok', 'red', 'failed', 'blocked', 'released', 'progress'] as const)!;
            h.clock.advanceMinutes(r.int(60));
            const res =
              kind === 'ok'
                ? await complete(h.o, sid, u.id)
                : kind === 'red'
                  ? await h.o.reportWork({ sessionId: sid, unitId: u.id, outcome: 'completed', summary: 'red', validation: { passed: false, checks: [{ name: 't', passed: false }] } })
                  : kind === 'blocked'
                    ? await h.o.reportWork({ sessionId: sid, unitId: u.id, outcome: 'blocked', summary: 'b', blocker: { kind: 'external', detail: 'x' } })
                    : await h.o.reportWork({ sessionId: sid, unitId: u.id, outcome: kind, summary: kind, checkpoint: 'cp' });
            // A finished (or otherwise reported) unit never ends or halts the session.
            expect(isHalted(res.state) && res.state !== before.state, `report halted ${trail.join(' ')}`).toBe(false);
            expect(isTerminal(res.state)).toBe(false);
            break;
          }
          case 'decide?': {
            const targets = before.units.filter((x) => ['pending', 'in_progress', 'blocked', 'failed'].includes(x.status) && x.kind === 'task');
            const t = r.pick(targets);
            await h.o.requestDecision({ sessionId: sid, question: 'q', whyItMatters: 'w', affectedUnitIds: t ? [t.id] : [] });
            break;
          }
          case 'decide!': {
            const d = r.pick(before.decisions.filter((x) => x.status === 'open'));
            if (d) await h.o.recordDecision({ sessionId: sid, decisionId: d.id, choice: 'yes', decidedBy: 'human', withdraw: r.chance(0.2) });
            break;
          }
          case 'add': {
            const dep = r.pick(before.units.filter((x) => x.kind === 'task'));
            await h.o.updateWorkGraph({
              sessionId: sid,
              units: [unit(`x${++added}`, { rationale: 'found during work', estimateMinutes: 10 + r.int(60), dependsOn: dep && r.chance(0.5) ? [dep.id] : [] })],
            });
            break;
          }
          case 'cancel': {
            const u = r.pick(before.units.filter((x) => x.kind === 'task' && x.status !== 'done' && x.status !== 'cancelled'));
            if (u) await h.o.updateWorkGraph({ sessionId: sid, cancel: [{ id: u.id, reason: 'descoped' }] });
            break;
          }
          case 'reopen': {
            const u = r.pick(before.units.filter((x) => ['blocked', 'failed', 'cancelled'].includes(x.status)));
            if (u) await h.o.updateWorkGraph({ sessionId: sid, reopen: [{ id: u.id, note: 'fixed' }] });
            break;
          }
          case 'pause':
            await h.o.pauseSession({ sessionId: sid });
            break;
          case 'resume':
            await h.o.resumeSession({
              sessionId: sid,
              mode: r.pick(['outside', 'desk', undefined] as const),
              addBudgetMinutes: r.chance(0.5) ? 30 + r.int(120) : undefined,
              takeover: r.chance(0.5),
            });
            break;
          case 'stop':
            await h.o.stopSession({ sessionId: sid, reason: 'r', markFailed: r.chance(0.05) });
            break;
          case 'time':
            h.clock.advanceMinutes(r.int(200));
            break;
        }
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        // Rule violations are fine; an illegal state transition is always a bug.
        expect(e.code, `${e.message} after ${trail.join(' ')}`).not.toBe('INVALID_TRANSITION');
      }

      const s = (await h.repo.load(sid))!;
      checkRecord(s, h.clock.now(), trail);
      if (terminalState) expect(s.state, 'terminal state changed').toBe(terminalState);
      if (isTerminal(s.state)) terminalState = s.state;
    }
  });
});

describe('budget is session-level; estimates are independent', () => {
  it('a unit that overruns its estimate is not penalized; budget is charged wall-clock time', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 300);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a', { estimateMinutes: 10 }), unit('b', { estimateMinutes: 10 })] });
    await h.o.nextWork(sid);
    h.clock.advanceMinutes(90);
    const r = await complete(h.o, sid, 'a');
    expect(r.unit.status).toBe('done');
    const next = await h.o.nextWork(sid);
    expect(next.dispatch?.assignments[0]?.unit.id).toBe('b');
    expect(next.budget.usedMinutes).toBe(90);
  });

  it('estimates never consume budget; only elapsed time does', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 100);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('big', { estimateMinutes: 80 })] });
    const next = await h.o.nextWork(sid);
    expect(next.budget.usedMinutes).toBe(0);
    h.clock.advanceMinutes(5); // finished far faster than estimated
    await complete(h.o, sid, 'big');
    expect((await h.o.getSession(sid)).session.budget.usedMinutes).toBe(5);
  });
});

describe('parallelism is policy-driven, not usage-driven', () => {
  const graph = [
    unit('a', { estimateMinutes: 20, touches: ['a'] }),
    unit('b', { estimateMinutes: 20, touches: ['b'] }),
    unit('c', { estimateMinutes: 90, touches: ['c'] }),
    unit('d', { estimateMinutes: 80, touches: ['c/sub'] }),
  ];

  it('the same graph gets the same dispatch whatever the remaining budget', async () => {
    const strategies = [];
    for (const budget of [200, 2_000, 20_000]) {
      const h = harness();
      const sid = await startOutside(h.o, budget);
      await h.o.updateWorkGraph({ sessionId: sid, units: graph });
      const next = await h.o.nextWork(sid);
      strategies.push(next.dispatch?.assignments.map((a) => `${a.unit.id}:${a.executor}`));
    }
    expect(strategies[0]).toEqual(strategies[1]);
    expect(strategies[1]).toEqual(strategies[2]);
  });

  it('small independent units stay direct even with a huge budget', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 10_000);
    await h.o.updateWorkGraph({
      sessionId: sid,
      units: [unit('a', { estimateMinutes: 15, touches: ['a'] }), unit('b', { estimateMinutes: 15, touches: ['b'] }), unit('c', { estimateMinutes: 15, touches: ['c'] })],
    });
    const next = await h.o.nextWork(sid);
    expect(next.dispatch).toMatchObject({ strategy: 'direct' });
    expect(next.dispatch?.assignments).toHaveLength(1);
  });
});

describe('handoff after an interruption', () => {
  it('shows the dead run\'s in-flight checkpoint before anyone resumes', async () => {
    const h = harness();
    const sid = await startOutside(h.o, 240);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a', { estimateMinutes: 30 }), unit('b')] });
    await h.o.nextWork(sid);
    await h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'progress', summary: 'half', checkpoint: 'migration written, not applied' });
    h.clock.advanceMinutes(240);

    const handoff = await h.o.getHandoff(sid);
    expect(handoff.liveness).toBe('stale');
    expect(handoff.inFlight).toEqual([expect.objectContaining({ id: 'a', checkpoint: 'migration written, not applied' })]);
    expect(handoff.nextActions.join('\n')).toMatch(/Continue in-flight a from checkpoint: migration written, not applied/);
    expect(handoff.markdown).toMatch(/## In flight/);

    await h.o.resumeSession({ sessionId: sid, mode: 'desk' });
    const { executed, last } = await drive(h, sid);
    expect(executed).toEqual(['a', 'b', 'validate-1']);
    expect(last.state).toBe('completed');
  });

  it('a paused run resumes with its claims and the main agent is reminded of its held unit', async () => {
    const h = harness();
    const sid = await startOutside(h.o);
    await h.o.updateWorkGraph({ sessionId: sid, units: [unit('a'), unit('b')] });
    await h.o.nextWork(sid);
    await h.o.pauseSession({ sessionId: sid });
    await h.o.resumeSession({ sessionId: sid });
    const next = await h.o.nextWork(sid);
    expect(next.action).toBe('wait');
    expect(next.guidance).toMatch(/still holds 'a'/);
    await h.o.reportWork({ sessionId: sid, unitId: 'a', outcome: 'completed', summary: 'ok', validation: passing() });
    expect((await h.o.nextWork(sid)).dispatch?.assignments[0]?.unit.id).toBe('b');
  });
});
