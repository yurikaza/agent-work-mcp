/**
 * Persisted session aggregate. Everything needed to resume a session after an
 * interruption lives in this one record.
 */

export type Mode = 'outside' | 'desk';

export const SESSION_STATES = [
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
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type UnitKind = 'task' | 'investigation' | 'validation';
export type UnitStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'blocked' | 'cancelled';
export type Priority = 'high' | 'normal' | 'low';
export type Executor = 'main' | 'subagent';
export type Isolation = 'shared' | 'worktree';
export type BlockerKind = 'environment' | 'access' | 'external' | 'dependency' | 'unknown';

export interface ValidationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ValidationEvidence {
  passed: boolean;
  checks: ValidationCheck[];
  notApplicableReason?: string;
}

export interface UnitClaim {
  at: string;
  executor: Executor;
  isolation: Isolation;
  dispatchId: string;
}

export interface UnitResult {
  summary: string;
  validation: ValidationEvidence;
  artifacts: string[];
  completedAt: string;
}

export interface WorkUnit {
  id: string;
  title: string;
  description?: string;
  kind: UnitKind;
  status: UnitStatus;
  dependsOn: string[];
  decisionIds: string[];
  estimateMinutes?: number;
  priority: Priority;
  acceptance: string[];
  workstream?: string;
  touches: string[];
  parallelSafe: boolean;
  rationale?: string;
  /** Added after the initial plan was submitted (mid-session scope). */
  addedLate: boolean;
  addedAt: string;
  attempts: number;
  claim?: UnitClaim;
  checkpoint?: string;
  blocker?: { kind: BlockerKind; detail: string; at: string };
  result?: UnitResult;
  notes: string[];
  /** For validation units: the task units this validation covers. */
  validates?: string[];
  /** For task units: the validation unit that verified this unit. */
  validatedBy?: string;
  cancelReason?: string;
}

export type DecisionCategory = 'architecture' | 'product' | 'scope' | 'security' | 'external' | 'other';
export type DecisionStatus = 'open' | 'resolved' | 'withdrawn';

export interface DecisionOption {
  id: string;
  label: string;
  consequences?: string;
}

export interface Decision {
  id: string;
  question: string;
  whyItMatters: string;
  category: DecisionCategory;
  options: DecisionOption[];
  recommendation?: string;
  affectedUnitIds: string[];
  status: DecisionStatus;
  raisedAt: string;
  raisedInMode: Mode;
  raisedDuringState: SessionState;
  resolution?: {
    choice: string;
    rationale?: string;
    decidedBy: string;
    decidedAt: string;
  };
}

export interface Phase {
  title: string;
  goal: string;
  exitCriteria: string[];
  constraints: string[];
}

export interface ProjectContext {
  summary: string;
  keyFiles: string[];
  commands: Record<string, string>;
  notes: string[];
  updatedAt: string;
}

export interface Budget {
  totalMinutes: number;
  consumedMs: number;
  /** ISO timestamp while the autonomous clock runs, otherwise null. */
  activeSince: string | null;
}

export interface Run {
  mode: Mode;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
}

export interface DispatchRecord {
  id: string;
  at: string;
  strategy: 'direct' | 'parallel';
  unitIds: string[];
  rationale: string[];
}

export interface SessionEvent {
  at: string;
  type: string;
  message: string;
}

export interface ProjectSnapshot {
  capturedAt: string;
  root: string;
  git?: {
    branch?: string;
    head?: string;
    dirtyFiles: string[];
  };
  docs: string[];
}

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  projectRoot: string;
  mode: Mode;
  state: SessionState;
  stateReason: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  phase: Phase;
  projectContext?: ProjectContext;
  budget: Budget;
  /** False until the first update_work_graph. Distinguishes "no plan yet" from "empty plan". */
  graphSubmitted: boolean;
  graphRevision: number;
  units: WorkUnit[];
  decisions: Decision[];
  runs: Run[];
  dispatches: DispatchRecord[];
  events: SessionEvent[];
  handoffNotes: string[];
  snapshot?: ProjectSnapshot;
  counters: { decision: number; validation: number; dispatch: number };
}
