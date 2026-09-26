import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DefaultRecoveryEngine } from '../src/recovery.ts'
import type { FailureId, FailureKind, FailureRecord, RecoveryAction } from '../src/types.ts'

/** One failure of the given kind. */
function failure(kind: FailureKind): FailureRecord {
  return { failureId: brandString<FailureId>(`failure-${kind}`), kind, detail: 'detail', at: 1 }
}

/** The recovery table the engine must implement, keyed by failure kind. */
const EXPECTED: Readonly<Record<FailureKind, RecoveryAction>> = {
  'model-auth': 'fail-closed',
  'model-rate-limit': 'retry',
  'model-context-overflow': 'compact',
  'tool-invalid-input': 'replan',
  'tool-policy-denied': 'ask-user',
  'tool-transient': 'retry',
  'sandbox-denied': 'ask-user',
  'approval-rejected': 'replan',
  timeout: 'retry',
  'budget-exhausted': 'checkpoint-pause',
  'stale-write': 'reread',
  'verification-failed': 'diagnose',
  // §8.5: a repair that broke a criterion an earlier verification passed is
  // diagnosed, and counts against the same repair budget.
  'verification-regressed': 'diagnose',
  'subagent-failed': 'settle-child',
  'workflow-failed': 'diagnose',
  'persistence-failed': 'fail-closed',
  'prompt-injection': 'quarantine',
  // S4's loop-robustness failures.
  'output-truncated': 'retry',
  'tool-args-malformed': 'diagnose',
  'no-progress': 'ask-user',
  stalled: 'retry',
  'step-ceiling': 'checkpoint-pause',
  'plan-drift': 'replan',
  unknown: 'diagnose',
}

describe('failure recovery', () => {
  it.each(Object.entries(EXPECTED))('classifies %s as %s', (kind, action) => {
    const engine = new DefaultRecoveryEngine({ checkpointBeforeRetry: false })
    const decision = engine.classify({ failure: failure(kind as FailureKind), attempts: 0, maxAttemptsPerAction: 2 })
    expect(decision.action).toBe(action)
    expect(decision.failureId).toBe(`failure-${kind}`)
    expect(decision.reason).toBe(`${kind} recovers by ${action}`)
  })

  it('bounds a retryable failure by the attempts already spent', () => {
    const engine = new DefaultRecoveryEngine({ checkpointBeforeRetry: false })
    const fresh = engine.classify({ failure: failure('tool-transient'), attempts: 1, maxAttemptsPerAction: 2 })
    expect(fresh).toMatchObject({ action: 'retry', retryable: true, attemptsRemaining: 1, checkpointRequired: false })

    const exhausted = engine.classify({ failure: failure('tool-transient'), attempts: 2, maxAttemptsPerAction: 2 })
    expect(exhausted).toMatchObject({ action: 'retry', retryable: false, attemptsRemaining: 0 })
    expect(exhausted.reason).toBe('tool-transient recovers by retry; no attempt remains of 2 for this action')

    const nonRetryable = engine.classify({ failure: failure('tool-policy-denied'), attempts: 0, maxAttemptsPerAction: 2 })
    expect(nonRetryable).toMatchObject({ retryable: false, attemptsRemaining: 0 })
  })

  it('requires a checkpoint before a retry when the deployment asks for one', () => {
    const engine = new DefaultRecoveryEngine({ checkpointBeforeRetry: true })
    expect(engine.classify({ failure: failure('timeout'), attempts: 0, maxAttemptsPerAction: 2 }).checkpointRequired).toBe(true)
    expect(engine.classify({ failure: failure('budget-exhausted'), attempts: 0, maxAttemptsPerAction: 2 }).checkpointRequired).toBe(true)
    expect(engine.classify({ failure: failure('model-auth'), attempts: 0, maxAttemptsPerAction: 2 }).checkpointRequired).toBe(false)
  })
})
