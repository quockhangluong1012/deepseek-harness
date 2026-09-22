/**
 * §22 drift signals: the evidence that questions a skill before elapsed
 * idleness retires it, derived from records the profile already holds.
 *
 * Four signals are recorded here, and each names its own source. A skill's
 * failure spike is the feedback store's decisive grading — a failure distinct
 * sessions reported, which a later load has not answered and which landed
 * inside the drift window; conflicting newer evidence is an uncertainty
 * signal of §43's `conflicting-evidence` kind recorded after the skill last
 * relied on anything; low measured utility is the skill's clean-outcome share
 * minus its peers', at or below the configured floor; and a dependency-version
 * change is a recorded lineage envelope whose tool, model, prompt, retriever,
 * evaluator, or environment version differs from the envelope before it.
 *
 * Two sources §22 names are not reachable from a skill and are not
 * approximated here. The knowledge graph's contradicted claims and the memory
 * store's `refutationCount` count per scope and per artifact, and no record
 * links either to a skill, so they reach the ladder only through the
 * per-skill `conflicting-evidence` signals the uncertainty store holds. §22's
 * task-distribution shift needs a task-class axis on skill usage, and no
 * record carries one: `evolution-meta` keys its runs by the optimizer's own
 * `taskClass` (the skill under optimization) and skill usage records sessions
 * rather than the tasks they asked for.
 * @module @deepseek-ai/dsh-evolution-curator/src/drift
 */

import { skillUtility } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'

/** Milliseconds in one day, the unit the drift window is configured in. */
const MS_PER_DAY = 86_400_000

/**
 * The §22 signals one pass read off a skill's recorded evidence. Each is
 * independent evidence; any one of them moves the skill to `suspect`.
 */
export interface DriftSignals {
  /** The feedback store graded a failure distinct sessions reported, unanswered and recent. */
  failureSpike: boolean
  /** Conflicting evidence was recorded after the skill last relied on anything. */
  conflictingEvidence: boolean
  /** The skill's recorded outcomes are no better than its peers'. */
  lowUtility: boolean
  /** A recorded dependency version changed after the skill was last used. */
  versionChange: boolean
}

/** Floors and windows behind the drift rules. */
export interface DriftFloors {
  /** Days a graded failure stays recent. */
  windowDays: number
  /** Utility excess at or below which a skill's measured utility counts as low. */
  utilityFloor: number
}

/**
 * One recorded experiment envelope, as the version rule reads it: the
 * dependencies the experiment ran under. Declared structurally rather than
 * imported so the curator keeps no dependency on the lineage package — the
 * store is an optional source, and a host without it still runs the other
 * three signals.
 */
export interface RecordedExperiment {
  /** Skill the experiment evaluated. */
  skill: string
  /** ISO-8601 instant the envelope was recorded. */
  at: string
  /** Dependency versions the experiment ran under, keyed by dependency name. */
  dependencies: Readonly<Record<string, string | undefined>>
}

/** The signals that fired, in the order a transition reason names them. */
const DRIFT_LABELS: readonly (readonly [keyof DriftSignals, string])[] = [
  ['failureSpike', 'failure spike'],
  ['conflictingEvidence', 'conflicting evidence'],
  ['lowUtility', 'low measured utility'],
  ['versionChange', 'dependency version change'],
]

/**
 * Name the §22 signals that fired, or undefined when none did.
 * @param signals - the signals the pass read.
 * @returns the transition reason, or undefined for a quiet skill.
 */
export function driftReason(signals: DriftSignals): string | undefined {
  const fired = DRIFT_LABELS.filter(([key]) => signals[key]).map(([, label]) => label)
  return fired.length === 0 ? undefined : `drift: ${fired.join(', ')}`
}

/**
 * Whether one recorded dependency version changed since the skill was last
 * used. The newest envelope is compared against the envelope before it, and
 * the skill's own version is skipped: the artifact under change is not the
 * environment the skill was validated in. A skill with fewer than two
 * envelopes has nothing to compare, and an envelope no newer than the skill's
 * last use describes an environment the recorded evidence already covers.
 * @param envelopes - the envelopes recorded for this skill.
 * @param asOf - epoch milliseconds of the skill's newest use or patch.
 * @returns whether a dependency version changed.
 */
export function dependencyChanged(envelopes: readonly RecordedExperiment[], asOf: number): boolean {
  const recorded = [...envelopes].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const newest = recorded[recorded.length - 1]
  const previous = recorded[recorded.length - 2]
  if (newest === undefined || previous === undefined) return false
  if (Date.parse(newest.at) <= asOf) return false
  return Object.entries(newest.dependencies)
    .some(([dependency, version]) => dependency !== 'skill' && version !== previous.dependencies[dependency])
}

/**
 * Read every §22 drift signal one skill's records hold. Pure: the caller
 * supplies the records, and nothing here reads a store or a clock.
 * @param usage - the skill's usage record.
 * @param peers - the other tracked skills, the baseline arm of the utility reading.
 * @param signals - the pass's graded failures for this skill's sessions.
 * @param conflicts - instants of `conflicting-evidence` signals recorded for this skill.
 * @param envelopes - lineage envelopes recorded for this skill.
 * @param now - epoch milliseconds the pass runs at.
 * @param floors - the drift window and the utility floor.
 * @returns which signals fired.
 */
export function driftSignals(
  usage: SkillUsageRecord,
  peers: readonly SkillUsageRecord[],
  signals: readonly FeedbackSignal[],
  conflicts: readonly string[],
  envelopes: readonly RecordedExperiment[],
  now: number,
  floors: DriftFloors,
): DriftSignals {
  const asOf = Math.max(
    Date.parse(usage.lastUsedAt ?? usage.createdAt),
    Date.parse(usage.lastPatchedAt ?? usage.createdAt),
    Date.parse(usage.createdAt),
  )
  const failureAt = usage.lastTrustFailure === null ? undefined : Date.parse(usage.lastTrustFailure.at)
  const unanswered = failureAt !== undefined
    && (usage.lastUsedAt === null || failureAt > Date.parse(usage.lastUsedAt))
  const utility = skillUtility(usage, peers).incrementalGain
  return {
    // The `unanswered` alias already proved a trust-failure instant exists, so
    // it narrows `failureAt` to that parsed instant here.
    failureSpike: unanswered
      && now - failureAt <= floors.windowDays * MS_PER_DAY
      && signals.some(signal => signal.actionability === 'trigger_review'),
    conflictingEvidence: conflicts.some(at => Date.parse(at) > asOf),
    lowUtility: utility !== null && utility <= floors.utilityFloor,
    versionChange: dependencyChanged(envelopes, asOf),
  }
}
