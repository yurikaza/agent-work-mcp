import { fail } from '../errors.js';
import type { Decision, Priority, WorkUnit } from './session.js';

export type Readiness =
  | 'ready'
  | 'waiting_on_dependencies'
  | 'waiting_on_decision'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type RootCauseKind = 'decision' | 'blocker' | 'failure' | 'cancelled';

export interface RootCause {
  kind: RootCauseKind;
  /** Decision id for `decision`, unit id otherwise. */
  ref: string;
}

export const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/** Units still owing work: they are neither done nor cancelled nor in flight. */
export const isRemaining = (u: WorkUnit): boolean =>
  u.status === 'pending' || u.status === 'blocked' || u.status === 'failed';

export const formatCause = (c: RootCause): string => `${c.kind}:${c.ref}`;

/**
 * Read-only index over a session's units and decisions. Build one per
 * evaluation; it does not observe later mutations.
 */
export class GraphIndex {
  private readonly byId = new Map<string, WorkUnit>();
  private readonly order = new Map<string, number>();
  private readonly dependents = new Map<string, string[]>();
  private readonly openDecisions: Set<string>;
  private readonly causeMemo = new Map<string, RootCause[]>();

  constructor(
    readonly units: readonly WorkUnit[],
    decisions: readonly Decision[],
  ) {
    units.forEach((u, i) => {
      this.byId.set(u.id, u);
      this.order.set(u.id, i);
    });
    for (const u of units) {
      for (const dep of u.dependsOn) {
        const list = this.dependents.get(dep) ?? [];
        list.push(u.id);
        this.dependents.set(dep, list);
      }
    }
    this.openDecisions = new Set(decisions.filter((d) => d.status === 'open').map((d) => d.id));
  }

  get(id: string): WorkUnit | undefined {
    return this.byId.get(id);
  }

  directDependents(id: string): string[] {
    return this.dependents.get(id) ?? [];
  }

  openDecisionIdsOf(u: WorkUnit): string[] {
    return u.decisionIds.filter((d) => this.openDecisions.has(d));
  }

  readiness(u: WorkUnit): Readiness {
    if (u.status !== 'pending') return u.status;
    if (this.openDecisionIdsOf(u).length > 0) return 'waiting_on_decision';
    const depsDone = u.dependsOn.every((d) => this.byId.get(d)?.status === 'done');
    return depsDone ? 'ready' : 'waiting_on_dependencies';
  }

  /**
   * Why a unit cannot run, traced through its unfinished ancestors. A unit that
   * is merely waiting on dependencies that will run has no root causes.
   */
  rootCauses(u: WorkUnit): RootCause[] {
    const memo = this.causeMemo.get(u.id);
    if (memo) return memo;
    this.causeMemo.set(u.id, []); // cycle guard; graphs are validated acyclic
    const causes: RootCause[] = [];
    if (u.status === 'done' || u.status === 'cancelled') {
      this.causeMemo.set(u.id, causes);
      return causes;
    }
    for (const d of this.openDecisionIdsOf(u)) causes.push({ kind: 'decision', ref: d });
    if (u.status === 'blocked') causes.push({ kind: 'blocker', ref: u.id });
    if (u.status === 'failed') causes.push({ kind: 'failure', ref: u.id });
    for (const depId of u.dependsOn) {
      const dep = this.byId.get(depId);
      if (!dep || dep.status === 'done') continue;
      if (dep.status === 'cancelled') causes.push({ kind: 'cancelled', ref: dep.id });
      else causes.push(...this.rootCauses(dep));
    }
    const unique = dedupeCauses(causes);
    this.causeMemo.set(u.id, unique);
    return unique;
  }

  /** All units that transitively depend on any of `ids` (excluding `ids`). */
  transitiveDependents(ids: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...ids];
    const roots = new Set(stack);
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of this.directDependents(id)) {
        if (seen.has(next) || roots.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  }

  /** How much remaining work a unit unblocks. Drives critical-path-first ordering. */
  unblockingPower(u: WorkUnit): number {
    let n = 0;
    for (const id of this.transitiveDependents([u.id])) {
      const dep = this.byId.get(id);
      if (dep && (isRemaining(dep) || dep.status === 'in_progress')) n++;
    }
    return n;
  }

  /** Ready units in scheduling order: unblocking power, priority, insertion order. */
  ready(): WorkUnit[] {
    const ready = this.units.filter((u) => this.readiness(u) === 'ready');
    const power = new Map(ready.map((u) => [u.id, this.unblockingPower(u)]));
    return ready.sort(
      (a, b) =>
        power.get(b.id)! - power.get(a.id)! ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        this.order.get(a.id)! - this.order.get(b.id)!,
    );
  }

  inFlight(): WorkUnit[] {
    return this.units.filter((u) => u.status === 'in_progress');
  }

  remaining(): WorkUnit[] {
    return this.units.filter(isRemaining);
  }
}

function dedupeCauses(causes: RootCause[]): RootCause[] {
  const seen = new Set<string>();
  return causes.filter((c) => {
    const key = formatCause(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Returns one cycle as a path (first id repeated at the end), or null. */
export function findCycle(units: readonly WorkUnit[]): string[] | null {
  const byId = new Map(units.map((u) => [u.id, u]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };

  for (const u of units) {
    const cycle = visit(u.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Structural checks applied to a complete draft graph before it is committed. */
export function assertGraphValid(units: readonly WorkUnit[], decisions: readonly Decision[]): void {
  const ids = new Set<string>();
  for (const u of units) {
    if (!UNIT_ID_PATTERN.test(u.id)) {
      fail('GRAPH_INVALID', `Unit id '${u.id}' must match ${UNIT_ID_PATTERN}.`);
    }
    if (ids.has(u.id)) fail('GRAPH_INVALID', `Duplicate unit id '${u.id}'.`);
    ids.add(u.id);
  }
  const decisionIds = new Set(decisions.map((d) => d.id));
  for (const u of units) {
    for (const dep of u.dependsOn) {
      if (dep === u.id) fail('GRAPH_INVALID', `Unit '${u.id}' depends on itself.`);
      if (!ids.has(dep)) fail('GRAPH_INVALID', `Unit '${u.id}' depends on unknown unit '${dep}'.`);
    }
    for (const d of u.decisionIds) {
      if (!decisionIds.has(d)) fail('GRAPH_INVALID', `Unit '${u.id}' references unknown decision '${d}'.`);
    }
  }
  const cycle = findCycle(units);
  if (cycle) fail('GRAPH_INVALID', `Dependency cycle: ${cycle.join(' -> ')}.`);
}
