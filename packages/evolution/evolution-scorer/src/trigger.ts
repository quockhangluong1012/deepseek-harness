/**
 * Optimization trigger: which tracked skills have enough recorded failure to
 * deserve an optimization run. Pure selection over telemetry records — the
 * caller owns exclusion policy and the optimizer owns what happens next.
 * @module @deepseek-ai/dsh-evolution-scorer/trigger
 */

import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { TriggerThresholds } from './types.ts'

/**
 * Decide whether one skill's recorded outcome warrants an optimization run.
 * A curator-graded session outcome is a task-level result — the session
 * that loaded the skill was itself verified or reported back, not merely
 * "the skill tool call didn't throw" — so it decides whenever the skill has
 * any (amendment S9): the rate is `failed / graded`, gated by `minUses`
 * graded sessions. Absent grading, the rate falls back to the load-error
 * counters `failureCount / (useCount + failureCount)` the telemetry record
 * documents, gated by `minUses` loads.
 * @param usage - the skill's telemetry record.
 * @param thresholds - minimum recorded loads and failure share.
 * @returns true when the skill should be optimized.
 */
export function shouldOptimize(usage: SkillUsageRecord, thresholds: TriggerThresholds): boolean {
  if (usage.sessionOutcomes.length > 0) {
    const graded = usage.sessionOutcomes.length
    if (graded < thresholds.minUses) return false
    const failed = usage.sessionOutcomes.filter(outcome => outcome.outcome === 'failed').length
    return failed / graded > thresholds.failureRate
  }
  const failureCount = usage.failureCount ?? 0
  const loads = usage.useCount + failureCount
  if (loads < thresholds.minUses) return false
  return failureCount / loads > thresholds.failureRate
}
