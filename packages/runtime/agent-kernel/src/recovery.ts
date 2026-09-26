/**
 * Failure classification and recovery selection. One table maps every
 * {@link FailureKind} to the recovery the kernel takes, so a reader of the log
 * sees the same answer for the same failure regardless of which executor
 * family reported it.
 *
 * Retry decisions carry their own bound: a transient failure never retries
 * past the configured attempts per action, and a deployment may require a
 * checkpoint before any retry so the action's side effects are not repeated
 * from an unknown state.
 *
 * @module @deepseek-ai/dsh-agent-kernel/recovery
 */

import type {
  DiagnosisFacts,
  FailureCategory,
  FailureDiagnosis,
  FailureKind,
  FailureSeverity,
  RecoveryAction,
  RecoveryDecision,
  RecoveryEngine,
  RecoveryInput,
} from './types.ts'

/** The recovery each failure kind takes, and whether it may be retried at all. */
const RECOVERY_BY_KIND: Readonly<Record<FailureKind, { action: RecoveryAction; retryable: boolean }>> = {
  'model-auth': { action: 'fail-closed', retryable: false },
  'model-rate-limit': { action: 'retry', retryable: true },
  'model-context-overflow': { action: 'compact', retryable: true },
  'tool-invalid-input': { action: 'replan', retryable: false },
  'tool-policy-denied': { action: 'ask-user', retryable: false },
  'tool-transient': { action: 'retry', retryable: true },
  'sandbox-denied': { action: 'ask-user', retryable: false },
  'approval-rejected': { action: 'replan', retryable: false },
  timeout: { action: 'retry', retryable: true },
  'budget-exhausted': { action: 'checkpoint-pause', retryable: false },
  'stale-write': { action: 'reread', retryable: true },
  'verification-failed': { action: 'diagnose', retryable: false },
  // §8.5: a repair that broke a criterion an earlier verification passed is
  // diagnosed like any other verification failure, and counts against the same
  // repair budget.
  'verification-regressed': { action: 'diagnose', retryable: false },
  'subagent-failed': { action: 'settle-child', retryable: false },
  'workflow-failed': { action: 'diagnose', retryable: false },
  'persistence-failed': { action: 'fail-closed', retryable: false },
  'prompt-injection': { action: 'quarantine', retryable: false },
  // S4: truncated output retries once with a larger limit, then the model is
  // steered to split the call; a malformed argument set is answered with the
  // parse or schema error before any approval; a run making no progress is
  // diagnosed and then handed to the user; a stalled step is cancelled,
  // checkpointed, and retried once; the step ceiling pauses the task.
  'output-truncated': { action: 'retry', retryable: true },
  'tool-args-malformed': { action: 'diagnose', retryable: false },
  'no-progress': { action: 'ask-user', retryable: false },
  stalled: { action: 'retry', retryable: true },
  'step-ceiling': { action: 'checkpoint-pause', retryable: false },
  // §7.4: a task whose actions stopped following its plan needs a new plan,
  // not another attempt at the same one.
  'plan-drift': { action: 'replan', retryable: false },
  unknown: { action: 'diagnose', retryable: false },
}

/** The family each failure kind belongs to. */
const CATEGORY_BY_KIND: Readonly<Record<FailureKind, FailureCategory>> = {
  'model-auth': 'model',
  'model-rate-limit': 'model',
  'model-context-overflow': 'model',
  'tool-invalid-input': 'tool',
  'tool-policy-denied': 'policy',
  'tool-transient': 'tool',
  'sandbox-denied': 'policy',
  'approval-rejected': 'approval',
  timeout: 'liveness',
  'budget-exhausted': 'budget',
  'stale-write': 'environment',
  'verification-failed': 'verification',
  'verification-regressed': 'verification',
  'subagent-failed': 'tool',
  'workflow-failed': 'tool',
  'persistence-failed': 'persistence',
  'prompt-injection': 'environment',
  'output-truncated': 'model',
  'tool-args-malformed': 'tool',
  'no-progress': 'liveness',
  stalled: 'liveness',
  'step-ceiling': 'budget',
  'plan-drift': 'verification',
  unknown: 'environment',
}

/**
 * How much each failure kind threatens the task. Severity answers whether the
 * task can continue at all: a `critical` failure means the record of what
 * happened is not trustworthy — credentials, a quarantined source, or a write
 * the kernel could not land.
 */
const SEVERITY_BY_KIND: Readonly<Record<FailureKind, FailureSeverity>> = {
  'model-auth': 'critical',
  'model-rate-limit': 'medium',
  'model-context-overflow': 'high',
  'tool-invalid-input': 'medium',
  'tool-policy-denied': 'medium',
  'tool-transient': 'low',
  'sandbox-denied': 'high',
  'approval-rejected': 'medium',
  timeout: 'medium',
  'budget-exhausted': 'high',
  'stale-write': 'medium',
  'verification-failed': 'high',
  'verification-regressed': 'high',
  'subagent-failed': 'high',
  'workflow-failed': 'high',
  'persistence-failed': 'critical',
  'prompt-injection': 'critical',
  'output-truncated': 'low',
  'tool-args-malformed': 'medium',
  'no-progress': 'high',
  stalled: 'high',
  'step-ceiling': 'high',
  'plan-drift': 'medium',
  unknown: 'medium',
}

/**
 * The strategy ladder one recovery escalates through, beginning with the action
 * the classifier chose. A recovery that cannot be repeated is not recommended
 * again here: the decision record already reports the attempts it has left.
 */
const ESCALATION_BY_ACTION: Readonly<Record<RecoveryAction, readonly RecoveryAction[]>> = {
  retry: ['retry', 'replan'],
  compact: ['compact', 'retry'],
  reread: ['reread', 'replan'],
  'ask-user': ['ask-user'],
  replan: ['replan', 'ask-user'],
  diagnose: ['diagnose', 'replan'],
  'checkpoint-pause': ['checkpoint-pause', 'ask-user'],
  'settle-child': ['settle-child', 'replan'],
  quarantine: ['quarantine'],
  'fail-closed': ['fail-closed'],
}

/** Deployment choices the recovery engine reads. */
export interface RecoveryConfig {
  /** Whether a retry must be preceded by a checkpoint. */
  readonly checkpointBeforeRetry: boolean
}

/**
 * The default failure classifier. It is stateless: the caller supplies the
 * attempt count, so the same input always produces the same decision.
 */
export class DefaultRecoveryEngine implements RecoveryEngine {
  /** Deployment choices this engine decides under. */
  private readonly config: RecoveryConfig

  /**
   * @param config - deployment choices for retry checkpointing.
   */
  constructor(config: RecoveryConfig) {
    this.config = config
  }

  /**
   * Diagnose one failure: its family, severity, the task facts it is read
   * against, and the ladder of recoveries to try. Diagnosis reads only the
   * failure's own classification and the facts the caller supplies, so a log
   * replayed later produces the same reading of what went wrong.
   * @param input - the failure, its attempt count, and the configured cap.
   * @param facts - the observations and hypotheses the task had recorded.
   * @returns the diagnosis the recovery decision is made against.
   */
  diagnose(input: RecoveryInput, facts: DiagnosisFacts): FailureDiagnosis {
    const { kind } = input.failure
    const category = CATEGORY_BY_KIND[kind]
    const severity = SEVERITY_BY_KIND[kind]
    const action = RECOVERY_BY_KIND[kind].action
    return {
      failureId: input.failure.failureId,
      category,
      severity,
      evidence: [...facts.evidence],
      hypotheses: [...facts.hypotheses],
      recommendedActions: [...ESCALATION_BY_ACTION[action]],
      detail: `${kind} is a ${severity} ${category} failure; the kernel recovers by ${action}`,
      at: Date.now(),
    }
  }

  /**
   * Classify one failure and choose its recovery. An exhausted retry budget
   * keeps the retry classification but reports `retryable: false` with no
   * attempts remaining, so the caller escalates rather than repeating the
   * action.
   * @param input - the failure, its attempt count, and the configured cap.
   * @returns the decided recovery.
   */
  classify(input: RecoveryInput): RecoveryDecision {
    const { failure, attempts, maxAttemptsPerAction } = input
    const entry = RECOVERY_BY_KIND[failure.kind]
    const attemptsRemaining = entry.retryable ? Math.max(0, maxAttemptsPerAction - attempts) : 0
    const retryable = entry.retryable && attemptsRemaining > 0
    const reasons: string[] = [`${failure.kind} recovers by ${entry.action}`]
    if (entry.retryable && !retryable) {
      reasons.push(`no attempt remains of ${maxAttemptsPerAction} for this action`)
    }
    return {
      failureId: failure.failureId,
      action: entry.action,
      retryable,
      attemptsRemaining,
      checkpointRequired: entry.action === 'checkpoint-pause'
        || (retryable && this.config.checkpointBeforeRetry),
      reason: reasons.join('; '),
      at: Date.now(),
    }
  }
}
