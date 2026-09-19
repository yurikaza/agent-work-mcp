import { describe, expect, it } from 'vitest';
import { fitsBudget, remainingMinutes, startClock, stopClock } from '../src/core/model/budget.js';
import { decisionImpact, orderDecisionQueue } from '../src/core/model/decisions.js';
import type { Decision, SessionState, WorkUnit } from '../src/core/model/session.js';
import { SESSION_STATES } from '../src/core/model/session.js';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  familyOf,
} from '../src/core/model/state-machine.js';
import { assertGraphValid, findCycle, GraphIndex } from '../src/core/model/work-graph.js';
import { DEFAULT_POLICY } from '../src/core/policy/policy.js';

const u = (id: string, extra: Partial<WorkUnit> = {}): WorkUnit => ({
  id,
  title: id,
  kind: 'task',
  status: 'pending',
  dependsOn: [],
  decisionIds: [],
  priority: 'normal',
  acceptance: [],
  touches: [],
  parallelSafe: true,
  addedLate: false,
  addedAt: '2026-09-19T09:00:00.000Z',
  attempts: 0,
  notes: [],
  ...extra,
});

const decision = (id: string, affected: string[], extra: Partial<Decision> = {}): Decision => ({
  id,
  question: `q ${id}`,
  whyItMatters: 'because',
  category: 'architecture',
  options: [],
  affectedUnitIds: affected,
  status: 'open',
  raisedAt: '2026-09-19T09:00:00.000Z',
  raisedInMode: 'outside',
  raisedDuringState: 'running',
  ...extra,
});

describe('state machine', () => {
  it('covers every required state', () => {
    expect([...SESSION_STATES].sort()).toEqual(
      [
        'idle',
        'analyzing',
        'planning',
        'running',
        'waiting_for_human',
        'blocked',
        'paused',
        'resumable',
        'validating',
        'completed',
        'failed',
      ].sort(),
    );
  });

  it('terminal states have no exits', () => {
    expect(allowedTransitions('completed')).toEqual([]);
    expect(allowedTransitions('failed')).toEqual([]);
    expect(() => assertTransition('completed', 'planning')).toThrow(/Cannot move/);
  });

  it('every non-terminal state can reach failed and every state is reachable from idle', () => {
    const reachable = new Set<SessionState>(['idle']);
    const queue: SessionState[] = ['idle'];
    while (queue.length) {
      for (const next of allowedTransitions(queue.shift()!)) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    expect([...reachable].sort()).toEqual([...SESSION_STATES].sort());
    for (const s of SESSION_STATES) {
      if (familyOf(s) !== 'terminal') expect(canTransition(s, 'failed')).toBe(true);
    }
  });

  it('halted sessions cannot jump straight into execution', () => {
    // A human decision may make work executable, but only resume re-enters an active state.
    expect(canTransition('waiting_for_human', 'running')).toBe(false);
    expect(canTransition('resumable', 'running')).toBe(false);
    expect(canTransition('waiting_for_human', 'resumable')).toBe(true);
  });

  it('classifies families', () => {
    expect(familyOf('running')).toBe('active');
    expect(familyOf('waiting_for_human')).toBe('halted');
    expect(familyOf('paused')).toBe('halted');
    expect(familyOf('completed')).toBe('terminal');
  });
});

describe('work graph', () => {
  it('derives readiness from dependencies and open decisions', () => {
    const units = [
      u('a', { status: 'done' }),
      u('b', { dependsOn: ['a'] }),
      u('c', { dependsOn: ['b'] }),
      u('d', { decisionIds: ['dec-1'] }),
      u('e', { decisionIds: ['dec-2'] }),
    ];
    const g = new GraphIndex(units, [decision('dec-1', ['d']), decision('dec-2', ['e'], { status: 'resolved' })]);
    expect(g.readiness(units[1]!)).toBe('ready');
    expect(g.readiness(units[2]!)).toBe('waiting_on_dependencies');
    expect(g.readiness(units[3]!)).toBe('waiting_on_decision');
    expect(g.readiness(units[4]!)).toBe('ready'); // resolved decisions no longer gate
  });

  it('traces root causes through ancestors', () => {
    const units = [
      u('api', { decisionIds: ['dec-1'] }),
      u('ui', { dependsOn: ['api'] }),
      u('infra', { status: 'blocked' }),
      u('deploy', { dependsOn: ['ui', 'infra'] }),
      u('old', { status: 'cancelled' }),
      u('uses-old', { dependsOn: ['old'] }),
      u('free'),
    ];
    const g = new GraphIndex(units, [decision('dec-1', ['api'])]);
    const causes = (id: string) => g.rootCauses(g.get(id)!).map((c) => `${c.kind}:${c.ref}`);
    expect(causes('ui')).toEqual(['decision:dec-1']);
    expect(causes('deploy').sort()).toEqual(['blocker:infra', 'decision:dec-1']);
    expect(causes('uses-old')).toEqual(['cancelled:old']);
    expect(causes('free')).toEqual([]);
  });

  it('orders ready units critical-path first, then priority', () => {
    const units = [
      u('leaf', { priority: 'high' }),
      u('root'),
      u('mid', { dependsOn: ['root'] }),
      u('top', { dependsOn: ['mid'] }),
      u('low', { priority: 'low' }),
    ];
    const g = new GraphIndex(units, []);
    expect(g.ready().map((x) => x.id)).toEqual(['root', 'leaf', 'low']);
  });

  it('detects cycles and invalid references', () => {
    expect(findCycle([u('a', { dependsOn: ['b'] }), u('b', { dependsOn: ['c'] }), u('c', { dependsOn: ['a'] })])).toEqual([
      'a',
      'b',
      'c',
      'a',
    ]);
    expect(() => assertGraphValid([u('a', { dependsOn: ['nope'] })], [])).toThrow(/unknown unit 'nope'/);
    expect(() => assertGraphValid([u('a', { decisionIds: ['dec-9'] })], [])).toThrow(/unknown decision/);
    expect(() => assertGraphValid([u('a', { dependsOn: ['a'] })], [])).toThrow(/depends on itself/);
    expect(() => assertGraphValid([u('bad id')], [])).toThrow(/must match/);
  });

  it('computes decision impact and queue order', () => {
    const units = [u('a'), u('b', { dependsOn: ['a'] }), u('c', { dependsOn: ['b'] }), u('x'), u('y')];
    const d1 = decision('dec-1', ['x']);
    const d2 = decision('dec-2', ['a'], { raisedAt: '2026-09-19T10:00:00.000Z' });
    const g = new GraphIndex(
      units.map((x) => (x.id === 'a' ? { ...x, decisionIds: ['dec-2'] } : x.id === 'x' ? { ...x, decisionIds: ['dec-1'] } : x)),
      [d1, d2],
    );
    expect(decisionImpact(d2, g).blockedUnitIds.sort()).toEqual(['a', 'b', 'c']);
    expect(decisionImpact(d2, g).independentReadyUnitIds).toEqual(['y']);
    expect(orderDecisionQueue([d1, d2], g).map((d) => d.id)).toEqual(['dec-2', 'dec-1']);
  });
});

describe('budget', () => {
  it('accumulates only while the clock runs', () => {
    const b = { totalMinutes: 60, consumedMs: 0, activeSince: null as string | null };
    const t0 = new Date('2026-09-19T09:00:00Z');
    startClock(b, t0);
    stopClock(b, new Date('2026-09-19T09:20:00Z'));
    expect(remainingMinutes(b, new Date('2026-09-19T12:00:00Z'))).toBe(40);
    startClock(b, new Date('2026-09-19T12:00:00Z'));
    expect(remainingMinutes(b, new Date('2026-09-19T12:10:00Z'))).toBe(30);
  });

  it('lets a long unit use a long budget but not a short one', () => {
    const p = DEFAULT_POLICY;
    expect(fitsBudget(240, 300, p)).toBe(true); // 4h task, 5h left
    expect(fitsBudget(240, 250, p)).toBe(true); // within overrun tolerance
    expect(fitsBudget(240, 30, p)).toBe(false);
    expect(fitsBudget(20, 30, p)).toBe(true);
    expect(fitsBudget(undefined, 30, p)).toBe(true);
    expect(fitsBudget(undefined, 12, p)).toBe(false); // below reserve + min start
  });
});
