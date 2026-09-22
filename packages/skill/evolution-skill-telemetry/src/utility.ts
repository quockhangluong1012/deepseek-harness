/**
 * Skill utility (§40): what a skill's recorded outcomes say it was worth.
 * The reading is derived from counters the store already keeps, so nothing
 * here writes or guesses; the two derived numbers are named for exactly the
 * comparison they make.
 *
 * The specification asks for `incremental_gain` against a no-skill baseline,
 * and this repository records no run that used no skill: every counter here
 * belongs to a session that loaded one. The shipped reading is therefore the
 * library-relative success excess — the skill's clean-outcome share minus the
 * pooled clean-outcome share of every other tracked skill — which compares a
 * skill against the library's other skills, never against doing without one.
 * That residual gap is a missing control arm, not a missing counter.
 *
 * Cost overhead is recorded work per unit of success: loads spent per
 * successful assisted task, read from the use counter rather than estimated.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry/src/utility
 */

import type { SkillUsageRecord } from './types.ts'

/** One skill's utility reading, derived from recorded evidence. */
export interface SkillUtility {
  /** Successful model loads of this skill, the spec's `uses`. */
  readonly uses: number
  /**
   * Sessions that loaded this skill and carry a recorded outcome, the spec's
   * `assisted_tasks`. A load with no outcome recorded yet is not counted.
   */
  readonly assistedTasks: number
  /** Assisted sessions with no attributable failure, the spec's `successful_tasks`. */
  readonly successfulTasks: number
  /**
   * Library-relative success excess, standing in for the spec's
   * `incremental_gain`: this skill's clean-outcome share minus the pooled
   * clean-outcome share of the other tracked skills. `null` when this skill
   * has no assisted task, or when no peer has one either, because neither
   * ratio exists to subtract. Never a measurement against a no-skill run —
   * this harness records none.
   */
  readonly incrementalGain: number | null
  /**
   * Recorded loads per successful assisted task, the spec's `cost_overhead`.
   * `null` when no assisted task succeeded, because a success is the
   * denominator.
   */
  readonly costOverhead: number | null
}

/**
 * Read one skill's utility against its peers' recorded outcomes.
 * @param record - the skill's usage record.
 * @param peers - the other tracked skills' records, supplying the baseline arm.
 * @returns the derived utility reading.
 */
export function skillUtility(
  record: SkillUsageRecord,
  peers: readonly SkillUsageRecord[],
): SkillUtility {
  const successfulTasks = record.sessionOutcomes.filter(entry => entry.outcome === 'ok').length
  const assistedTasks = record.sessionOutcomes.length
  const pooled = peers.flatMap(peer => peer.sessionOutcomes)
  const peerSuccesses = pooled.filter(entry => entry.outcome === 'ok').length
  return {
    uses: record.useCount,
    assistedTasks,
    successfulTasks,
    incrementalGain: assistedTasks === 0 || pooled.length === 0
      ? null
      : successfulTasks / assistedTasks - peerSuccesses / pooled.length,
    costOverhead: successfulTasks === 0 ? null : record.useCount / successfulTasks,
  }
}
