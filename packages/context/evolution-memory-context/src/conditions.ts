/**
 * The recorded conditions a nudge fires on. §53 replaces the periodic nudge
 * with condition-based metacognitive triggers: each condition names the store
 * whose evidence decides it, the section its line renders into, and the
 * operator surface that acts on it. Every line builder is pure — the caller
 * fetched the evidence — so wording is a unit test rather than a host fixture,
 * and nothing here is generic advice: a line states the count and the
 * condition, or it does not render at all.
 * @module @deepseek-ai/dsh-evolution-memory-context/conditions
 */

import type { BenchmarkState, BenchmarkTask, EvolutionBenchmark } from '@deepseek-ai/dsh-evolution-benchmark'
import type { EvolutionFeedback, FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { EvolutionMemoryRecord, EvolutionScopeId, LessonArtifact, StagedWrite } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionSkillTelemetry, SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'

/** The nudge sections a condition can render into. */
export type NudgeSection = 'memory' | 'skills'

/** Stable identity of one recorded condition. */
export type NudgeConditionId =
  | 'staged-writes'
  | 'contradicted-claims'
  | 'failure-signals'
  | 'skill-trust'
  | 'holdout-gaps'

/** One recorded condition: the evidence that decides it and where it renders. */
export interface NudgeCondition {
  /** Stable identity, keying the cadence ceiling. */
  readonly id: NudgeConditionId
  /** Section whose text carries this condition's line. */
  readonly section: NudgeSection
  /** Service holding the evidence; named in the line rendered when it is unmounted. */
  readonly store: string
  /** What the condition reads, named in the line rendered when its store is unmounted. */
  readonly subject: string
}

/** Every recorded condition, in the order an assembly evaluates them. */
export const NUDGE_CONDITIONS: readonly NudgeCondition[] = [
  { id: 'staged-writes', section: 'memory', store: 'evolutionMemory', subject: 'staged writes' },
  { id: 'contradicted-claims', section: 'memory', store: 'evolutionMemory', subject: 'contradicted claims' },
  { id: 'skill-trust', section: 'skills', store: 'evolutionSkillTelemetry', subject: 'skill trust' },
  { id: 'failure-signals', section: 'skills', store: 'evolutionFeedback', subject: 'failure signals' },
  { id: 'holdout-gaps', section: 'skills', store: 'evolutionBenchmark', subject: 'benchmark holdout coverage' },
]

/** What one assembly knows when it evaluates the conditions. */
export interface NudgeEvidence {
  /** Scope the session belongs to, or undefined when it belongs to no workspace. */
  readonly scope: EvolutionScopeId | undefined
  /** Session ids of the scope's workspace, which the failure aggregation covers. */
  readonly sessionIds: readonly string[]
  /** Assembly instant, in epoch milliseconds. */
  readonly now: number
}

/** The evidence the mounted stores hold, read once per assembly. */
export interface NudgeDeps {
  /** The scope's memory record, undefined outside a scope or before its first write. */
  readonly record: EvolutionMemoryRecord | undefined
  /** Failure-observation store, or undefined when it is unmounted. */
  readonly feedback: EvolutionFeedback | undefined
  /** Skill-usage store, or undefined when it is unmounted. */
  readonly telemetry: EvolutionSkillTelemetry | undefined
  /** Benchmark store, or undefined when it is unmounted. */
  readonly benchmark: EvolutionBenchmark | undefined
  /** Minutes a staged write may wait before the memory nudge names it. */
  readonly stagedWriteWaitMinutes: number
  /** Failure signals one evaluation grades. */
  readonly failureSignalScanLimit: number
}

/** States in which a capability is still being learned, so it needs a holdout. */
const LEARNABLE: ReadonlySet<BenchmarkState> = new Set(['fresh', 'search', 'validation'])

/**
 * Render the line for a store the assembly could not read. An unmounted store
 * leaves its condition unevaluable, which is neither satisfied nor silently
 * absent, so the line names the store instead of guessing at its contents.
 * @param condition - the condition whose evidence is missing.
 * @returns the one-line notice naming the unmounted store.
 */
export function unevaluableLine(condition: NudgeCondition): string {
  return `${condition.subject} cannot be checked: the ${condition.store} store is not mounted.`
}

/**
 * Render the staged-write line. Staged entries are recorded oldest first, so
 * the first entry decides whether any write waited past the review window.
 * @param staged - the scope's pending staged writes, oldest first.
 * @param waitMinutes - minutes a write may wait before it is named.
 * @param now - current instant, in epoch milliseconds.
 * @returns the line, or undefined while every pending write is inside the window.
 */
export function stagedWriteLine(staged: readonly StagedWrite[], waitMinutes: number, now: number): string | undefined {
  const oldest = staged[0]
  if (oldest === undefined) return undefined
  if (now - Date.parse(oldest.createdAt) < waitMinutes * 60_000) return undefined
  return `Staged writes: ${staged.length} pending, the oldest since ${oldest.createdAt}, past the ${waitMinutes}-minute review window; run /memory pending.`
}

/**
 * Render the contradicted-claim line. A fact is contradicted when a later
 * extraction refuted it without correcting it, and only while it still stands:
 * a corrected fact carries fresh counters and an invalidated one is no longer
 * an active claim.
 * @param artifacts - the scope's lesson artifacts.
 * @returns the line, or undefined while no standing fact is contradicted.
 */
export function contradictedClaimLine(artifacts: readonly LessonArtifact[]): string | undefined {
  const contradicted = artifacts.filter(artifact => (
    artifact.lifecycle !== 'invalidated' && artifact.refutationCount > 0
  )).length
  if (contradicted === 0) return undefined
  return `Contradicted claims: ${contradicted} active claim${contradicted === 1 ? '' : 's'} with contradicting evidence; run /claims.`
}

/**
 * Render the failure-signal line. The store grades a signal `trigger_review`
 * once it reaches the review threshold on its own evidence, so the store's
 * grade is the threshold this condition reads.
 * @param signals - failure signals aggregated over the scope's sessions, most decisive first.
 * @returns the line, or undefined while no signal reached the threshold.
 */
export function failureSignalLine(signals: readonly FeedbackSignal[]): string | undefined {
  const decisive = signals.filter(signal => signal.actionability === 'trigger_review').length
  if (decisive === 0) return undefined
  return `Failure signals: ${decisive} at the review threshold across this scope's sessions; record the durable lesson with skill_manage.`
}

/**
 * Render the skill-trust line: a skill standing at provisional trust after a
 * recorded demotion, which is the store's own record of trust that fell.
 * @param entries - the skill usage records, as the telemetry store lists them.
 * @returns the line, or undefined while no demotion stands unanswered.
 */
export function skillTrustLine(
  entries: readonly { readonly name: string; readonly usage: SkillUsageRecord }[],
): string | undefined {
  const fallen = entries.filter(entry => entry.usage.trust === 'provisional' && entry.usage.trustFailures > 0).length
  if (fallen === 0) return undefined
  return `Skill trust: ${fallen} provisional after a recorded failure; run /curator status.`
}

/**
 * Render the holdout line: a capability under evaluation whose tasks never
 * climbed to the ladder's protected rung, so nothing measures it out of band.
 * @param tasks - every benchmark task the store holds.
 * @returns the line, or undefined while every learnable capability has a holdout.
 */
export function holdoutGapLine(tasks: readonly BenchmarkTask[]): string | undefined {
  const covered = new Set(tasks.filter(task => task.state === 'holdout').map(task => task.capability))
  const uncovered = new Set(tasks
    .filter(task => LEARNABLE.has(task.state))
    .map(task => task.capability)
    .filter(capability => !covered.has(capability)))
  if (uncovered.size === 0) return undefined
  return `Benchmark holdouts: ${uncovered.size} under evaluation with no holdout task; run /benchmark.`
}

/** Evaluate one condition against the evidence the mounted stores hold, returning its line or undefined when it is quiet. */
export type NudgeEvaluator = (
  /** The condition to evaluate. */
  condition: NudgeCondition,
  /** Scope, session roster, and instant of this assembly. */
  evidence: NudgeEvidence,
  /** The evidence read from the stores for this assembly. */
  deps: NudgeDeps,
) => string | undefined

/**
 * One evaluator per condition. A condition bound to a scope stays quiet
 * without one — outside every workspace there is no scope for it to read —
 * while a condition whose store is unmounted renders its notice either way.
 */
export const NUDGE_EVALUATORS: Readonly<Record<NudgeConditionId, NudgeEvaluator>> = {
  'staged-writes': (_condition, evidence, deps) => evidence.scope === undefined
    ? undefined
    : stagedWriteLine(deps.record?.staged ?? [], deps.stagedWriteWaitMinutes, evidence.now),
  'contradicted-claims': (_condition, evidence, deps) => evidence.scope === undefined
    ? undefined
    : contradictedClaimLine(deps.record?.agentLessons ?? []),
  'skill-trust': (condition, _evidence, deps) => deps.telemetry === undefined
    ? unevaluableLine(condition)
    : skillTrustLine(deps.telemetry.entries()),
  'failure-signals': (condition, evidence, deps) => deps.feedback === undefined
    ? unevaluableLine(condition)
    : failureSignalLine(deps.feedback.signals(evidence.sessionIds, deps.failureSignalScanLimit)),
  'holdout-gaps': (condition, _evidence, deps) => deps.benchmark === undefined
    ? unevaluableLine(condition)
    : holdoutGapLine(deps.benchmark.tasks()),
}
