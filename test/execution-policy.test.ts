import { describe, expect, it } from 'vitest';
import type { WorkUnit } from '../src/core/model/session.js';
import { pathsOverlap, planExecution } from '../src/core/policy/execution-policy.js';
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
  touches: [`src/${id}`],
  parallelSafe: true,
  addedLate: false,
  addedAt: '2026-09-19T09:00:00.000Z',
  attempts: 0,
  notes: [],
  estimateMinutes: 60,
  ...extra,
});

const outside = { mode: 'outside' as const, policy: DEFAULT_POLICY };

describe('planExecution', () => {
  it('runs large isolated units in parallel; main takes the largest', () => {
    const plan = planExecution([u('a', { estimateMinutes: 60 }), u('b', { estimateMinutes: 90 })], [], outside);
    expect(plan.strategy).toBe('parallel');
    expect(plan.assignments).toEqual([
      { unitId: 'b', executor: 'main', isolation: 'shared' },
      { unitId: 'a', executor: 'subagent', isolation: 'worktree' },
    ]);
    expect(plan.rationale.join(' ')).toMatch(/saves ~60m/);
  });

  it('prefers direct execution when parallel savings are not material', () => {
    const plan = planExecution([u('a', { estimateMinutes: 20 }), u('b', { estimateMinutes: 20 })], [], outside);
    expect(plan.strategy).toBe('direct');
    expect(plan.assignments).toEqual([{ unitId: 'a', executor: 'main', isolation: 'shared' }]);
    expect(plan.rationale[0]).toMatch(/below the 30m threshold/);
  });

  it('refuses parallelism without provable isolation', () => {
    const overlapping = planExecution([u('a', { touches: ['src/api'] }), u('b', { touches: ['src/api/users.ts'] })], [], outside);
    expect(overlapping.strategy).toBe('direct');
    const sameStream = planExecution([u('a', { workstream: 'db' }), u('b', { workstream: 'db' })], [], outside);
    expect(sameStream.strategy).toBe('direct');
    const noTouches = planExecution([u('a', { touches: [] }), u('b')], [], outside);
    expect(noTouches.strategy).toBe('direct');
    expect(noTouches.rationale[0]).toMatch(/isolation cannot be proven/);
    const noEstimate = planExecution([u('a', { estimateMinutes: undefined }), u('b')], [], outside);
    expect(noEstimate.rationale[0]).toMatch(/no estimate/);
  });

  it('drops small units that would make parallelism worse and respects maxParallel', () => {
    const plan = planExecution(
      [u('a', { estimateMinutes: 90 }), u('b', { estimateMinutes: 80 }), u('c', { estimateMinutes: 5 }), u('d'), u('e')],
      [],
      outside,
    );
    expect(plan.strategy).toBe('parallel');
    expect(plan.assignments.length).toBeLessThanOrEqual(DEFAULT_POLICY.maxParallel);
    expect(plan.assignments.map((a) => a.unitId)).not.toContain('c');
  });

  it('is always sequential in DESK_MODE', () => {
    const desk = { mode: 'desk' as const, policy: DEFAULT_POLICY };
    expect(planExecution([u('a'), u('b')], [], desk).assignments).toHaveLength(1);
    expect(planExecution([u('b')], [u('a', { status: 'in_progress' })], desk).assignments).toHaveLength(0);
  });

  it('never gives the main agent a second unit while it holds one', () => {
    const held = u('a', {
      status: 'in_progress',
      claim: { at: 'x', executor: 'main', isolation: 'shared', dispatchId: 'd-1' },
    });
    expect(planExecution([u('b')], [held], outside).assignments).toHaveLength(0);
  });

  it('lets the main agent take an isolated unit while subagents work', () => {
    const sub = u('a', {
      status: 'in_progress',
      claim: { at: 'x', executor: 'subagent', isolation: 'worktree', dispatchId: 'd-1' },
    });
    expect(planExecution([u('b')], [sub], outside).assignments).toEqual([
      { unitId: 'b', executor: 'main', isolation: 'shared' },
    ]);
    expect(planExecution([u('c', { touches: ['src/a/x.ts'] })], [sub], outside).assignments).toHaveLength(0);
  });
});

describe('pathsOverlap', () => {
  it.each([
    ['src/api', 'src/api/users.ts', true],
    ['src/api', 'src/apiary', false],
    ['src/**', 'src/web/app.ts', true],
    ['src/foo*.ts', 'src/bar.ts', true],
    ['docs', 'src', false],
    ['.', 'anything', true],
    ['./lib/', 'lib/x', true],
  ])('%s vs %s -> %s', (a, b, expected) => {
    expect(pathsOverlap(a, b)).toBe(expected);
  });
});
