export interface Policy {
  /** Max units in flight at once, main agent included. */
  maxParallel: number;
  /** Cost of spinning up one extra agent (context loading, briefing). */
  agentOverheadMinutes: number;
  /** Cost for the main agent to integrate one extra unit of parallel output. */
  integrationMinutes: number;
  /** Parallel dispatch must save at least this much elapsed time, net of costs. */
  minSavingsMinutes: number;
  /** Budget held back for integration validation before halting. */
  budgetReserveMinutes: number;
  /** A unit may be started if its estimate exceeds usable budget by at most this fraction. */
  budgetOverrunTolerance: number;
  /** Don't start new task work with less usable budget than this. */
  minStartMinutes: number;
  /** Attempts before a unit is marked failed. */
  maxAttempts: number;
  /** Active sessions with no activity for this long are considered interrupted. */
  staleAfterMinutes: number;
}

export const DEFAULT_POLICY: Policy = {
  maxParallel: 3,
  agentOverheadMinutes: 10,
  integrationMinutes: 5,
  minSavingsMinutes: 30,
  budgetReserveMinutes: 10,
  budgetOverrunTolerance: 0.25,
  minStartMinutes: 5,
  maxAttempts: 3,
  staleAfterMinutes: 60,
};
