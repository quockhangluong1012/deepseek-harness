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

import type { FailureKind, RecoveryAction, RecoveryDecision, RecoveryEngine, RecoveryInput } from './types.ts'

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
  unknown: { action: 'diagnose', retryable: false },
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
