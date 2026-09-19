import type { Budget } from './session.js';

const MINUTE = 60_000;

export function consumedMs(budget: Budget, now: Date): number {
  const running = budget.activeSince ? Math.max(0, now.getTime() - Date.parse(budget.activeSince)) : 0;
  return budget.consumedMs + running;
}

export function usedMinutes(budget: Budget, now: Date): number {
  return consumedMs(budget, now) / MINUTE;
}

export function remainingMinutes(budget: Budget, now: Date): number {
  return budget.totalMinutes - usedMinutes(budget, now);
}

/** Start the autonomous clock if it is not already running. */
export function startClock(budget: Budget, at: Date): void {
  if (!budget.activeSince) budget.activeSince = at.toISOString();
}

/**
 * Stop the clock and bank the elapsed time. `at` may be earlier than now: after
 * an interruption the clock is closed at the last recorded activity.
 */
export function stopClock(budget: Budget, at: Date): void {
  if (!budget.activeSince) return;
  budget.consumedMs += Math.max(0, at.getTime() - Date.parse(budget.activeSince));
  budget.activeSince = null;
}

export interface BudgetFitPolicy {
  budgetReserveMinutes: number;
  budgetOverrunTolerance: number;
  minStartMinutes: number;
}

/**
 * Whether a task unit may be started with the budget that is left. The session
 * budget is not a per-task limit: a 4-hour unit fits a budget with ~4 hours left.
 * A reserve is held back so integration validation can always run.
 */
export function fitsBudget(
  estimateMinutes: number | undefined,
  remaining: number,
  policy: BudgetFitPolicy,
): boolean {
  const usable = remaining - policy.budgetReserveMinutes;
  if (estimateMinutes === undefined) return usable >= policy.minStartMinutes;
  if (usable < policy.minStartMinutes) return false;
  return estimateMinutes <= usable * (1 + policy.budgetOverrunTolerance);
}
