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
 * The rate is `failureCount / (useCount + failureCount)` — the formula the
 * telemetry record documents and the curator's staging step already reads —
 * and both thresholds must be crossed: a rate over a handful of loads says
 * nothing, so `minUses` gates the ratio, and a rate at the threshold is not
 * yet over it.
 * @param usage - the skill's telemetry record.
 * @param thresholds - minimum recorded loads and failure share.
 * @returns true when the skill should be optimized.
 */
export function shouldOptimize(usage: SkillUsageRecord, thresholds: TriggerThresholds): boolean {
  const failureCount = usage.failureCount ?? 0
  const loads = usage.useCount + failureCount
  if (loads < thresholds.minUses) return false
  return failureCount / loads > thresholds.failureRate
}
