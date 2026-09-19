import type { Executor, Isolation, Mode, WorkUnit } from '../model/session.js';
import type { Policy } from './policy.js';

export interface Assignment {
  unitId: string;
  executor: Executor;
  isolation: Isolation;
}

export interface ExecutionPlan {
  strategy: 'direct' | 'parallel';
  /** Empty means: dispatch nothing now (wait for in-flight work). */
  assignments: Assignment[];
  rationale: string[];
}

export interface PlanContext {
  mode: Mode;
  policy: Policy;
}

/**
 * Decide how to execute the next work. Parallelism must be earned: units have to
 * be provably isolated and the elapsed-time saving must beat the cost of extra
 * agents and integration. Otherwise the main agent executes directly.
 *
 * @param ready  ready task units in scheduling order (best first)
 * @param inFlight units currently claimed
 */
export function planExecution(ready: readonly WorkUnit[], inFlight: readonly WorkUnit[], ctx: PlanContext): ExecutionPlan {
  const { policy } = ctx;
  const anchor = ready[0];
  if (!anchor) return { strategy: 'direct', assignments: [], rationale: ['No ready units.'] };

  const mainBusy = inFlight.find((u) => u.claim?.executor === 'main');
  if (mainBusy) {
    return {
      strategy: 'direct',
      assignments: [],
      rationale: [`Main agent still holds '${mainBusy.id}'. Finish and report it before taking more work.`],
    };
  }

  if (ctx.mode === 'desk') {
    if (inFlight.length > 0) {
      return {
        strategy: 'direct',
        assignments: [],
        rationale: ['DESK_MODE runs one unit at a time; finish the in-flight unit first.'],
      };
    }
    return direct(anchor, ['DESK_MODE is human-in-the-loop and sequential.']);
  }

  if (inFlight.length > 0) {
    if (inFlight.length >= policy.maxParallel) {
      return {
        strategy: 'direct',
        assignments: [],
        rationale: [`${inFlight.length} units in flight (max ${policy.maxParallel}); wait for one to finish.`],
      };
    }
    const candidate = ready.find((u) => isParallelEligible(u) && isolatedFromAll(u, inFlight));
    if (!candidate) {
      return {
        strategy: 'direct',
        assignments: [],
        rationale: ['No ready unit is provably isolated from the in-flight subagent work; wait for it.'],
      };
    }
    return direct(candidate, [
      `'${candidate.id}' is isolated from in-flight subagent work; the main agent can execute it meanwhile.`,
    ]);
  }

  const ineligible = parallelIneligibility(anchor);
  if (ineligible) return direct(anchor, [`Top unit '${anchor.id}' runs directly: ${ineligible}.`]);

  const selected: WorkUnit[] = [anchor];
  for (const u of ready.slice(1)) {
    if (selected.length >= policy.maxParallel) break;
    if (isParallelEligible(u) && isolatedFromAll(u, selected)) selected.push(u);
  }
  if (selected.length < 2) {
    return direct(anchor, [`No other ready unit is provably isolated from '${anchor.id}'.`]);
  }

  // Pick the prefix with the best net saving; extra small units can make it worse.
  let best: { n: number; net: number; savings: number; cost: number } | undefined;
  for (let n = 2; n <= selected.length; n++) {
    const s = parallelEconomics(selected.slice(0, n), policy);
    if (!best || s.net > best.net) best = { n, ...s };
  }
  if (!best || best.net < policy.minSavingsMinutes) {
    const b = best ?? { savings: 0, cost: 0 };
    return direct(anchor, [
      `Parallel would save ~${round(b.savings)}m but cost ~${round(b.cost)}m in agent overhead and integration; ` +
        `net gain is below the ${policy.minSavingsMinutes}m threshold.`,
    ]);
  }

  const chosen = selected.slice(0, best.n).sort((a, b) => (b.estimateMinutes ?? 0) - (a.estimateMinutes ?? 0));
  const assignments: Assignment[] = chosen.map((u, i) =>
    i === 0
      ? { unitId: u.id, executor: 'main', isolation: 'shared' }
      : { unitId: u.id, executor: 'subagent', isolation: 'worktree' },
  );
  return {
    strategy: 'parallel',
    assignments,
    rationale: [
      `${chosen.length} ready units are isolated (disjoint workstreams and touched paths).`,
      `Parallel saves ~${round(best.savings)}m elapsed for ~${round(best.cost)}m of overhead (net ~${round(best.net)}m).`,
      'Main agent executes the largest unit, integrates subagent output, reports every unit, and owns validation.',
    ],
  };
}

function direct(u: WorkUnit, rationale: string[]): ExecutionPlan {
  return { strategy: 'direct', assignments: [{ unitId: u.id, executor: 'main', isolation: 'shared' }], rationale };
}

function parallelEconomics(units: readonly WorkUnit[], policy: Policy) {
  const estimates = units.map((u) => u.estimateMinutes ?? 0);
  const savings = estimates.reduce((a, b) => a + b, 0) - Math.max(...estimates);
  const cost = (units.length - 1) * (policy.agentOverheadMinutes + policy.integrationMinutes);
  return { savings, cost, net: savings - cost };
}

function parallelIneligibility(u: WorkUnit): string | null {
  if (!u.parallelSafe) return 'marked parallelSafe: false';
  if (u.kind === 'validation') return 'validation is integration work';
  if (u.estimateMinutes === undefined) return 'no estimate, so parallel savings cannot be justified';
  if (u.touches.length === 0) return 'no declared touches, so isolation cannot be proven';
  return null;
}

export const isParallelEligible = (u: WorkUnit): boolean => parallelIneligibility(u) === null;

export function isolatedFromAll(u: WorkUnit, others: readonly WorkUnit[]): boolean {
  return others.every((o) => o.id !== u.id && isolated(u, o));
}

function isolated(a: WorkUnit, b: WorkUnit): boolean {
  if (a.workstream && b.workstream && a.workstream === b.workstream) return false;
  if (a.touches.length === 0 || b.touches.length === 0) return false;
  return !a.touches.some((x) => b.touches.some((y) => pathsOverlap(x, y)));
}

/** Path-prefix overlap. Globs are reduced to their literal prefix. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (x === '' || y === '') return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  const glob = s.search(/[*?[{]/);
  if (glob >= 0) {
    // Keep only whole path segments before the glob: 'src/foo*.ts' -> 'src'.
    s = s.slice(0, glob);
    s = s.slice(0, s.lastIndexOf('/') + 1);
  }
  s = s.replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '.' ? '' : s;
}

const round = (n: number) => Math.round(n);
