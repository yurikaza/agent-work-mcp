import type { Decision } from './session.js';
import { GraphIndex, isRemaining } from './work-graph.js';

export interface DecisionImpact {
  /** Remaining or in-flight units that cannot finish until the decision is made. */
  blockedUnitIds: string[];
  /** Ready units outside the blocked set: work that continues regardless. */
  independentReadyUnitIds: string[];
}

export function decisionImpact(decision: Decision, graph: GraphIndex): DecisionImpact {
  const direct = decision.affectedUnitIds.filter((id) => graph.get(id));
  const blocked = new Set<string>();
  if (decision.status === 'open') {
    for (const id of [...direct, ...graph.transitiveDependents(direct)]) {
      const u = graph.get(id);
      if (u && (isRemaining(u) || u.status === 'in_progress')) blocked.add(id);
    }
  }
  const independentReadyUnitIds = graph
    .ready()
    .filter((u) => u.kind !== 'validation' && !blocked.has(u.id))
    .map((u) => u.id);
  return { blockedUnitIds: [...blocked], independentReadyUnitIds };
}

/** Open decisions first by how much work they block, then oldest first. */
export function orderDecisionQueue(decisions: readonly Decision[], graph: GraphIndex): Decision[] {
  const blocking = new Map(decisions.map((d) => [d.id, decisionImpact(d, graph).blockedUnitIds.length]));
  const statusRank = { open: 0, resolved: 1, withdrawn: 2 } as const;
  return [...decisions].sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      blocking.get(b.id)! - blocking.get(a.id)! ||
      Date.parse(a.raisedAt) - Date.parse(b.raisedAt),
  );
}
