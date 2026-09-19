import { MemorySessionRepository } from '../src/adapters/persistence/memory-repository.js';
import type { UnitInput } from '../src/core/contracts.js';
import type { ProjectSnapshot, SessionRepository } from '../src/index.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import type { Policy } from '../src/core/policy/policy.js';
import type { Clock, IdGenerator, ProjectInspector } from '../src/core/ports.js';

export class FakeClock implements Clock {
  private t: number;
  constructor(start = '2026-09-19T09:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceMinutes(m: number): void {
    this.t += m * 60_000;
  }
}

export function sequentialIds(prefix = 'ses_test'): IdGenerator {
  let n = 0;
  return { sessionId: () => `${prefix}${++n}` };
}

export const fakeInspector: ProjectInspector = {
  async inspect(root: string): Promise<ProjectSnapshot> {
    return {
      capturedAt: '2026-09-19T09:00:00.000Z',
      root,
      git: { branch: 'main', head: 'abc123', dirtyFiles: [] },
      docs: ['README.md', 'docs/architecture.md'],
    };
  },
};

export interface Harness {
  o: Orchestrator;
  clock: FakeClock;
  repo: SessionRepository;
}

export function harness(opts: { policy?: Partial<Policy>; repo?: SessionRepository; clock?: FakeClock } = {}): Harness {
  const clock = opts.clock ?? new FakeClock();
  const repo = opts.repo ?? new MemorySessionRepository();
  const o = new Orchestrator({
    repository: repo,
    clock,
    ids: sequentialIds(),
    inspector: fakeInspector,
    policy: opts.policy,
    defaultProjectRoot: '/tmp/project',
  });
  return { o, clock, repo };
}

export async function startOutside(o: Orchestrator, budgetMinutes = 240, extra: { exitCriteria?: string[] } = {}) {
  const r = await o.startSession({
    mode: 'outside',
    goal: 'Ship phase 1',
    budgetMinutes,
    projectRoot: '/tmp/project',
    ...extra,
  });
  return r.session.sessionId;
}

export const unit = (id: string, extra: Partial<UnitInput> = {}): UnitInput => ({
  id,
  title: `Do ${id}`,
  acceptance: [`${id} works`],
  ...extra,
});

export const passing = (name = 'tests') => ({ passed: true, checks: [{ name, passed: true }] });

/** Report a claimed unit as completed with passing evidence. */
export async function complete(o: Orchestrator, sessionId: string, unitId: string, summary = `${unitId} done`) {
  return o.reportWork({ sessionId, unitId, outcome: 'completed', summary, validation: passing() });
}

/**
 * Drive the OUTSIDE loop the way a well-behaved agent would: next_work, complete
 * every dispatched unit, repeat until stop. Returns the dispatched unit ids in order
 * and the final next_work result.
 */
export async function drive(h: Harness, sessionId: string, minutesPerUnit = 10, maxSteps = 50) {
  const executed: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const next = await h.o.nextWork(sessionId);
    if (next.action === 'stop' || next.action === 'plan') return { executed, last: next };
    if (next.action === 'wait') throw new Error(`unexpected wait: ${next.guidance}`);
    for (const a of next.dispatch!.assignments) {
      h.clock.advanceMinutes(minutesPerUnit);
      await complete(h.o, sessionId, a.unit.id);
      executed.push(a.unit.id);
    }
  }
  throw new Error('drive() did not reach a stop');
}

export function byId<T extends { id: string }>(units: readonly T[], id: string): T {
  const u = units.find((x) => x.id === id);
  if (!u) throw new Error(`no unit ${id}`);
  return u;
}
