/**
 * Staged-candidate selection: which tracked skills a curator pass flags for
 * review because their recorded outcome says the skill is not working. Pure
 * selection over telemetry records — the pass owns exclusion policy, the
 * ledger owns the record, and nothing here writes.
 * @module @deepseek-ai/dsh-evolution-curator/src/stage
 */

import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { StageThresholds, StagedCandidate } from './types.ts'

/**
 * Decide whether one skill's recorded outcome warrants staging. The rate is
 * `failureCount / (useCount + failureCount)` — the formula the telemetry
 * record documents — and both thresholds must be crossed: a rate over a
 * handful of loads says nothing, so `minUses` gates the ratio, and a rate at
 * the threshold is not yet over it.
 * @param name - skill name.
 * @param usage - the skill's telemetry record.
 * @param thresholds - minimum recorded loads and failure share.
 * @returns the staged candidate, or undefined when the skill stays unstaged.
 */
export function stageCandidate(
  name: string,
  usage: SkillUsageRecord,
  thresholds: StageThresholds,
): StagedCandidate | undefined {
  const failureCount = usage.failureCount ?? 0
  const loads = usage.useCount + failureCount
  if (loads < thresholds.minUses) return undefined
  const failureRate = failureCount / loads
  if (failureRate <= thresholds.failureRate) return undefined
  return {
    name,
    useCount: usage.useCount,
    failureCount,
    failureRate,
    reason: `failures ${failureCount}/${loads} exceed ${Math.round(thresholds.failureRate * 100)}%`,
  }
}

/**
 * Order staged candidates worst failure rate first, ties by ascending name so
 * a pass over equal rates stays deterministic.
 * @param candidates - staged candidates in encounter order.
 * @returns a new array in reporting order.
 */
export function orderStaged<T extends StagedCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) =>
    right.failureRate - left.failureRate || (left.name < right.name ? -1 : 1))
}
