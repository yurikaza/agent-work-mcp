export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'SESSION_TERMINAL'
  | 'SESSION_ACTIVE'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_CONFLICT'
  | 'CONFLICT'
  | 'GRAPH_INVALID'
  | 'UNIT_NOT_CLAIMED'
  | 'UNIT_IMMUTABLE'
  | 'VALIDATION_REQUIRED'
  | 'RATIONALE_REQUIRED'
  | 'DECISION_REQUIRES_HUMAN'
  | 'DECISION_NOT_OPEN'
  | 'BUDGET_REQUIRED'
  | 'BUDGET_EXHAUSTED';

/**
 * A rule violation the caller can act on. Adapters translate it into their own
 * error shape (MCP: a tool result with isError: true).
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new DomainError(code, message);
}
