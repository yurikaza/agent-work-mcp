/**
 * Command (input) and view (output) contracts. Transport-neutral: the MCP layer
 * uses them as tool schemas, a CLI could use them for argument validation.
 */
import * as z from 'zod';
import { SESSION_STATES } from './model/session.js';

// ─── shared enums ────────────────────────────────────────────────────────────

export const ModeSchema = z.enum(['outside', 'desk']);
export const SessionStateSchema = z.enum(SESSION_STATES);
export const UnitStatusSchema = z.enum(['pending', 'in_progress', 'done', 'failed', 'blocked', 'cancelled']);
export const ReadinessSchema = z.enum([
  'ready',
  'waiting_on_dependencies',
  'waiting_on_decision',
  'in_progress',
  'done',
  'failed',
  'blocked',
  'cancelled',
]);
export const PrioritySchema = z.enum(['high', 'normal', 'low']);
export const ExecutorSchema = z.enum(['main', 'subagent']);
export const IsolationSchema = z.enum(['shared', 'worktree']);
export const BlockerKindSchema = z.enum(['environment', 'access', 'external', 'dependency', 'unknown']);
export const DecisionCategorySchema = z.enum(['architecture', 'product', 'scope', 'security', 'external', 'other']);
export const DecisionStatusSchema = z.enum(['open', 'resolved', 'withdrawn']);
export const LivenessSchema = z.enum(['active', 'stale', 'idle']);
export const StopReasonSchema = z.enum([
  'budget_exhausted',
  'budget_insufficient',
  'waiting_for_human',
  'blocked',
  'completed',
  'failed',
  'paused',
  'not_active',
]);

const sessionId = z.string().min(1).describe('Session handle returned by start_session.');
const nonEmpty = z.string().trim().min(1);

// ─── commands ────────────────────────────────────────────────────────────────

export const StartSessionInput = z.object({
  mode: ModeSchema.describe(
    "'outside' = bounded autonomous run with no human present (primary). 'desk' = human in the loop.",
  ),
  goal: nonEmpty.describe('The outcome this session owns, typically the current project phase objective.'),
  phaseTitle: z.string().optional().describe('Short name of the phase. Defaults to the goal.'),
  exitCriteria: z.array(nonEmpty).optional().describe('Observable conditions that mean the phase is done.'),
  constraints: z.array(nonEmpty).optional().describe('Boundaries the agent must respect (areas not to touch, etc.).'),
  budgetMinutes: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60)
    .optional()
    .describe('Total autonomous wall-clock budget for the whole session. Required for outside mode.'),
  projectRoot: z.string().optional().describe('Absolute path of the project. Defaults to the server working directory.'),
});
export type StartSessionInput = z.infer<typeof StartSessionInput>;

export const SessionIdInput = z.object({ sessionId });

export const ListSessionsInput = z.object({
  projectRoot: z.string().optional().describe('Only sessions for this project root.'),
  includeTerminal: z.boolean().optional().describe('Include completed and failed sessions. Default true.'),
});
export type ListSessionsInput = z.infer<typeof ListSessionsInput>;

export const UnitInput = z.object({
  id: nonEmpty.describe('Stable slug, e.g. "auth-api". Letters, digits, ".", "_", "-".'),
  title: z.string().optional().describe('Required when adding a unit.'),
  description: z.string().optional(),
  kind: z.enum(['task', 'investigation']).optional().describe("Default 'task'. Investigations need no integration validation."),
  dependsOn: z.array(nonEmpty).optional().describe('Unit ids that must be done first.'),
  decisionIds: z.array(nonEmpty).optional().describe('Decision ids (dec-N) that must be resolved first.'),
  estimateMinutes: z.number().positive().optional().describe('Honest estimate. Enables budget fit and parallel planning.'),
  priority: PrioritySchema.optional(),
  acceptance: z.array(nonEmpty).optional().describe('What done means. Evidence is required at completion.'),
  workstream: z.string().optional().describe('Units in the same workstream never run in parallel.'),
  touches: z.array(nonEmpty).optional().describe('Paths/areas this unit changes. Needed to prove parallel isolation.'),
  parallelSafe: z.boolean().optional().describe('Set false to force direct execution. Default true.'),
  rationale: z.string().optional().describe('Why this unit is needed. Required for units added after the initial plan.'),
});
export type UnitInput = z.infer<typeof UnitInput>;

export const ProjectContextInput = z.object({
  summary: z.string().optional().describe('What the agent learned about the project, so later readers skip discovery.'),
  keyFiles: z.array(z.string()).optional(),
  commands: z.record(z.string(), z.string()).optional().describe('e.g. { "test": "npm test", "build": "npm run build" }'),
  notes: z.array(z.string()).optional(),
});

export const UpdateWorkGraphInput = z.object({
  sessionId,
  units: z.array(UnitInput).optional().describe('Units to add or update (upsert by id).'),
  cancel: z.array(z.object({ id: nonEmpty, reason: nonEmpty })).optional().describe('Remove units from scope.'),
  reopen: z
    .array(z.object({ id: nonEmpty, note: nonEmpty }))
    .optional()
    .describe('Return blocked, failed or cancelled units to pending (resets attempts).'),
  projectContext: ProjectContextInput.optional(),
});
export type UpdateWorkGraphInput = z.infer<typeof UpdateWorkGraphInput>;

export const WorkGraphFilter = z.enum(['all', 'remaining', 'ready', 'in_progress', 'done']);
export const GetWorkGraphInput = z.object({
  sessionId,
  filter: WorkGraphFilter.optional().describe("Default 'all'."),
});
export type GetWorkGraphInput = z.infer<typeof GetWorkGraphInput>;

export const ValidationEvidenceInput = z.object({
  passed: z.boolean(),
  checks: z
    .array(z.object({ name: nonEmpty, passed: z.boolean(), detail: z.string().optional() }))
    .describe('What was run or verified, e.g. tests, build, manual check of an acceptance criterion.'),
  notApplicableReason: z.string().optional().describe('Only when no check can apply. Explain why.'),
});

export const ReportWorkInput = z.object({
  sessionId,
  unitId: nonEmpty,
  outcome: z
    .enum(['progress', 'completed', 'failed', 'blocked', 'released'])
    .describe(
      'progress = checkpoint/heartbeat; completed = done with passing validation; failed = attempt failed; ' +
        'blocked = external blocker; released = hand the unit back unstarted or partially done.',
    ),
  summary: nonEmpty.describe('What happened, in one or two sentences.'),
  checkpoint: z.string().optional().describe('Exact resume point for unfinished work.'),
  validation: ValidationEvidenceInput.optional().describe('Required for completed.'),
  blocker: z.object({ kind: BlockerKindSchema, detail: nonEmpty }).optional().describe('Required for blocked.'),
  artifacts: z.array(z.string()).optional().describe('Files changed, commits, PRs.'),
});
export type ReportWorkInput = z.infer<typeof ReportWorkInput>;

export const RequestDecisionInput = z.object({
  sessionId,
  question: nonEmpty.describe('Answerable by a human without reading code.'),
  whyItMatters: nonEmpty.describe('What goes wrong if this is decided badly or not at all.'),
  category: DecisionCategorySchema.optional(),
  options: z
    .array(z.object({ id: z.string().optional(), label: nonEmpty, consequences: z.string().optional() }))
    .optional(),
  recommendation: z.string().optional().describe('Your suggestion. Stored as a suggestion; never applied.'),
  affectedUnitIds: z.array(nonEmpty).optional().describe('Units that cannot proceed until this is decided.'),
  checkpoint: z.string().optional().describe('Resume point for an in-progress affected unit.'),
});
export type RequestDecisionInput = z.infer<typeof RequestDecisionInput>;

export const GetDecisionsInput = z.object({
  sessionId,
  status: z.enum(['open', 'resolved', 'withdrawn', 'all']).optional().describe("Default 'open'."),
});
export type GetDecisionsInput = z.infer<typeof GetDecisionsInput>;

export const RecordDecisionInput = z.object({
  sessionId,
  decisionId: nonEmpty,
  choice: z.string().optional().describe('The human decision: an option id/label or free text. Required unless withdraw.'),
  rationale: z.string().optional(),
  decidedBy: nonEmpty.describe('Name of the human who decided.'),
  withdraw: z.boolean().optional().describe('The question no longer applies.'),
});
export type RecordDecisionInput = z.infer<typeof RecordDecisionInput>;

export const PauseSessionInput = z.object({
  sessionId,
  reason: z.string().optional(),
  notes: z.array(z.string()).optional().describe('Handoff notes for whoever resumes.'),
});
export type PauseSessionInput = z.infer<typeof PauseSessionInput>;

export const ResumeSessionInput = z.object({
  sessionId,
  mode: ModeSchema.optional().describe('Switch mode on resume. Default: keep current mode.'),
  addBudgetMinutes: z.number().int().positive().optional().describe('Extend the autonomous budget.'),
  takeover: z
    .boolean()
    .optional()
    .describe('Take over a session that still looks active (e.g. the previous agent died recently).'),
});
export type ResumeSessionInput = z.infer<typeof ResumeSessionInput>;

export const StopSessionInput = z.object({
  sessionId,
  reason: nonEmpty,
  notes: z.array(z.string()).optional().describe('Handoff notes for whoever resumes.'),
  markFailed: z.boolean().optional().describe('End the session permanently as failed.'),
});
export type StopSessionInput = z.infer<typeof StopSessionInput>;

// ─── views ───────────────────────────────────────────────────────────────────

export const BudgetView = z.object({
  totalMinutes: z.number(),
  usedMinutes: z.number(),
  remainingMinutes: z.number(),
  clockRunning: z.boolean(),
});
export type BudgetView = z.infer<typeof BudgetView>;

export const PhaseDef = z.object({
  title: z.string(),
  goal: z.string(),
  exitCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
});

export const ProjectContextView = z.object({
  summary: z.string(),
  keyFiles: z.array(z.string()),
  commands: z.record(z.string(), z.string()),
  notes: z.array(z.string()),
  updatedAt: z.string(),
});

export const SnapshotView = z.object({
  capturedAt: z.string(),
  root: z.string(),
  git: z
    .object({ branch: z.string().optional(), head: z.string().optional(), dirtyFiles: z.array(z.string()) })
    .optional(),
  docs: z.array(z.string()),
});

export const ValidationEvidenceView = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
  notApplicableReason: z.string().optional(),
});

export const UnitView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  kind: z.enum(['task', 'investigation', 'validation']),
  status: UnitStatusSchema,
  readiness: ReadinessSchema,
  rootCauses: z.array(z.string()).describe('Why the unit cannot run: decision:<id>, blocker:<unit>, failure:<unit>, cancelled:<unit>.'),
  dependsOn: z.array(z.string()),
  dependents: z.array(z.string()),
  decisionIds: z.array(z.string()),
  estimateMinutes: z.number().optional(),
  priority: PrioritySchema,
  acceptance: z.array(z.string()),
  workstream: z.string().optional(),
  touches: z.array(z.string()),
  parallelSafe: z.boolean(),
  rationale: z.string().optional(),
  addedLate: z.boolean(),
  attempts: z.number(),
  claim: z
    .object({ at: z.string(), executor: ExecutorSchema, isolation: IsolationSchema, dispatchId: z.string() })
    .optional(),
  checkpoint: z.string().optional(),
  blocker: z.object({ kind: BlockerKindSchema, detail: z.string(), at: z.string() }).optional(),
  result: z
    .object({
      summary: z.string(),
      validation: ValidationEvidenceView,
      artifacts: z.array(z.string()),
      completedAt: z.string(),
    })
    .optional(),
  notes: z.array(z.string()),
  validates: z.array(z.string()).optional(),
  validatedBy: z.string().optional(),
  cancelReason: z.string().optional(),
});
export type UnitView = z.infer<typeof UnitView>;

export const UnitBrief = z.object({
  id: z.string(),
  title: z.string(),
  status: UnitStatusSchema,
  readiness: ReadinessSchema,
  estimateMinutes: z.number().optional(),
  rootCauses: z.array(z.string()),
  checkpoint: z.string().optional(),
  summary: z.string().optional(),
});
export type UnitBrief = z.infer<typeof UnitBrief>;

export const DecisionView = z.object({
  id: z.string(),
  question: z.string(),
  whyItMatters: z.string(),
  category: DecisionCategorySchema,
  options: z.array(z.object({ id: z.string(), label: z.string(), consequences: z.string().optional() })),
  recommendation: z.string().optional(),
  affectedUnitIds: z.array(z.string()),
  status: DecisionStatusSchema,
  raisedAt: z.string(),
  raisedInMode: ModeSchema,
  raisedDuringState: SessionStateSchema,
  resolution: z
    .object({ choice: z.string(), rationale: z.string().optional(), decidedBy: z.string(), decidedAt: z.string() })
    .optional(),
  blockingCount: z.number().describe('Remaining units that wait on this decision (directly or transitively).'),
  blockedUnitIds: z.array(z.string()),
  independentReadyUnitIds: z.array(z.string()).describe('Ready work that can continue regardless of this decision.'),
});
export type DecisionView = z.infer<typeof DecisionView>;

export const RunView = z.object({
  mode: ModeSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  endReason: z.string().optional(),
});

export const SessionSummary = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  mode: ModeSchema,
  state: SessionStateSchema,
  stateReason: z.string(),
  liveness: LivenessSchema,
  phaseTitle: z.string(),
  goal: z.string(),
  budget: BudgetView,
  openDecisions: z.number(),
  remainingUnits: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const InFlightView = z.object({
  unitId: z.string(),
  title: z.string(),
  executor: ExecutorSchema,
  isolation: IsolationSchema,
  claimedAt: z.string(),
  checkpoint: z.string().optional(),
});

export const SessionView = SessionSummary.extend({
  family: z.enum(['initial', 'active', 'halted', 'terminal']),
  phase: PhaseDef,
  graphSubmitted: z.boolean(),
  graphRevision: z.number(),
  counts: z.object({
    total: z.number(),
    pending: z.number(),
    ready: z.number(),
    in_progress: z.number(),
    done: z.number(),
    failed: z.number(),
    blocked: z.number(),
    cancelled: z.number(),
  }),
  inFlight: z.array(InFlightView),
  runs: z.array(RunView),
});
export type SessionView = z.infer<typeof SessionView>;

export const DispatchView = z.object({
  dispatchId: z.string(),
  strategy: z.enum(['direct', 'parallel']),
  rationale: z.array(z.string()),
  assignments: z.array(z.object({ executor: ExecutorSchema, isolation: IsolationSchema, unit: UnitView })),
});

export const NextWorkResult = z.object({
  sessionId: z.string(),
  mode: ModeSchema,
  state: SessionStateSchema,
  action: z.enum(['plan', 'execute', 'wait', 'stop']),
  stopReason: StopReasonSchema.optional(),
  dispatch: DispatchView.optional(),
  inFlight: z.array(InFlightView),
  budget: BudgetView,
  openDecisions: z.number(),
  guidance: z.string(),
});
export type NextWorkResult = z.infer<typeof NextWorkResult>;

export const UpdateWorkGraphResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  graphRevision: z.number(),
  added: z.array(z.string()),
  updated: z.array(z.string()),
  cancelled: z.array(z.string()),
  reopened: z.array(z.string()),
  readyUnitIds: z.array(z.string()),
  guidance: z.string(),
});
export type UpdateWorkGraphResult = z.infer<typeof UpdateWorkGraphResult>;

export const ReportWorkResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  unit: UnitView,
  newlyReadyUnitIds: z.array(z.string()),
  guidance: z.string(),
});
export type ReportWorkResult = z.infer<typeof ReportWorkResult>;

export const RequestDecisionResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  decision: DecisionView,
  releasedUnitIds: z.array(z.string()),
  guidance: z.string(),
});
export type RequestDecisionResult = z.infer<typeof RequestDecisionResult>;

export const RecordDecisionResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  decision: DecisionView,
  unblockedUnitIds: z.array(z.string()),
  guidance: z.string(),
});
export type RecordDecisionResult = z.infer<typeof RecordDecisionResult>;

export const DecisionsResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  mode: ModeSchema,
  canRecordDecisions: z.boolean(),
  decisions: z.array(DecisionView),
});
export type DecisionsResult = z.infer<typeof DecisionsResult>;

export const WorkGraphResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  graphRevision: z.number(),
  units: z.array(UnitView),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).describe('from depends on to.'),
});
export type WorkGraphResult = z.infer<typeof WorkGraphResult>;

export const PhaseResult = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  phase: PhaseDef,
  progress: z.object({
    totalUnits: z.number(),
    done: z.number(),
    remaining: z.number(),
    inFlight: z.number(),
    cancelled: z.number(),
    percentDone: z.number(),
  }),
  openDecisions: z.number(),
  projectContext: ProjectContextView.optional(),
});
export type PhaseResult = z.infer<typeof PhaseResult>;

export const HandoffView = z.object({
  sessionId: z.string(),
  generatedAt: z.string(),
  projectRoot: z.string(),
  mode: ModeSchema,
  state: SessionStateSchema,
  stateReason: z.string(),
  liveness: LivenessSchema,
  phase: PhaseDef,
  projectContext: ProjectContextView.optional(),
  budget: BudgetView,
  decisionsNeeded: z.array(DecisionView),
  inFlight: z.array(UnitBrief),
  readyNext: z.array(UnitBrief),
  blocked: z.array(UnitBrief),
  completed: z.array(UnitBrief),
  repository: SnapshotView.optional(),
  notes: z.array(z.string()),
  nextActions: z.array(z.string()),
  markdown: z.string(),
});
export type HandoffView = z.infer<typeof HandoffView>;

export const ReportView = z.object({
  sessionId: z.string(),
  generatedAt: z.string(),
  outcome: SessionStateSchema,
  stateReason: z.string(),
  phase: PhaseDef,
  budget: BudgetView.extend({ unusedReason: z.string().optional() }),
  runs: z.array(RunView),
  unitCounts: SessionView.shape.counts,
  completed: z.array(
    z.object({ id: z.string(), title: z.string(), summary: z.string(), validation: ValidationEvidenceView, validatedBy: z.string().optional() }),
  ),
  unresolved: z.array(UnitBrief),
  decisions: z.object({
    raised: z.number(),
    resolved: z.number(),
    withdrawn: z.number(),
    open: z.array(z.object({ id: z.string(), question: z.string(), blockingCount: z.number() })),
  }),
  dispatches: z.object({
    total: z.number(),
    parallel: z.number(),
    parallelRationale: z.array(z.string()),
  }),
  validation: z.object({
    runs: z.number(),
    passed: z.number(),
    failedAttempts: z.number(),
    unvalidatedCompletedUnits: z.array(z.string()),
  }),
  scopeAddedMidSession: z.array(z.object({ id: z.string(), title: z.string(), rationale: z.string() })),
  nextSteps: z.array(z.string()),
  markdown: z.string(),
});
export type ReportView = z.infer<typeof ReportView>;

export const StartSessionResult = z.object({
  session: SessionView,
  snapshot: SnapshotView.optional(),
  otherSessions: z.array(SessionSummary).describe('Non-terminal sessions already recorded for this project.'),
  guidance: z.string(),
});
export type StartSessionResult = z.infer<typeof StartSessionResult>;

export const ListSessionsResult = z.object({ sessions: z.array(SessionSummary) });
export type ListSessionsResult = z.infer<typeof ListSessionsResult>;

export const SessionResult = z.object({ session: SessionView, guidance: z.string() });
export type SessionResult = z.infer<typeof SessionResult>;

export const ResumeSessionResult = z.object({
  session: SessionView,
  recoveredFromInterruption: z.boolean(),
  releasedUnitIds: z.array(z.string()),
  handoff: HandoffView,
  guidance: z.string(),
});
export type ResumeSessionResult = z.infer<typeof ResumeSessionResult>;

export const StopSessionResult = z.object({ session: SessionView, report: ReportView });
export type StopSessionResult = z.infer<typeof StopSessionResult>;
