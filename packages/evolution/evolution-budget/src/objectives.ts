/**
 * The §27 resource-aware objectives, read from what the batch already
 * recorded: quality and reliability from its candidate pool, latency, cost,
 * and background compute from its spends. Memory footprint and context usage
 * have no recording source anywhere in the harness, so they read null and name
 * the record they are missing rather than inventing a number. No I/O, no
 * domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-budget/src/objectives
 */

import { recordedTotal } from './budget.ts'
import type { EvolutionObjective, ObjectiveReading, PooledCandidate, SpendRecord } from './types.ts'

/** The seven §27 objectives, in canonical order. */
export const EVOLUTION_OBJECTIVES: readonly EvolutionObjective[] = [
  'quality',
  'reliability',
  'latency',
  'cost',
  'memory-footprint',
  'context-usage',
  'background-compute',
]

/**
 * Read every §27 objective the batch's records answer. Quality is the pass
 * share over its pool's recorded evaluations; reliability is the share of
 * twice-evaluated candidates that passed every time, the one repetition
 * reading the pool holds; latency is mean wall time per evaluated rollout;
 * cost is the billed tokens the spends recorded; background compute is the
 * offline tokens the spends attributed to the batch. Memory footprint and
 * context usage stay unmeasured because no store records either.
 * @param pool - the batch's recorded candidate pool.
 * @param spent - the batch's spend records.
 * @returns the readings, canonical order.
 */
export function objectiveReadings(
  pool: readonly PooledCandidate[],
  spent: readonly SpendRecord[],
): readonly ObjectiveReading[] {
  const runs = pool.reduce((sum, candidate) => sum + candidate.runs, 0)
  const passes = pool.reduce((sum, candidate) => sum + candidate.passes, 0)
  const repeated = pool.filter(candidate => candidate.runs >= 2)
  const unanimous = repeated.filter(candidate => candidate.passes === candidate.runs).length
  const rollouts = spent.reduce((sum, record) => sum + record.rollouts, 0)
  const wallTimeMs = spent.reduce((sum, record) => sum + record.wallTimeMs, 0)
  const tokens = spent.reduce((sum, record) => sum + record.tokens, 0)
  const background = recordedTotal(spent, record => record.backgroundTokens)
  return [
    {
      objective: 'quality',
      unit: 'share',
      value: runs === 0 ? null : passes / runs,
      source: runs === 0
        ? 'not measurable: no recorded pool candidate carries an evaluation (PooledCandidate.runs)'
        : 'pool: PooledCandidate.passes / PooledCandidate.runs',
    },
    {
      objective: 'reliability',
      unit: 'share',
      value: repeated.length === 0 ? null : unanimous / repeated.length,
      source: repeated.length === 0
        ? 'not measurable: no pool candidate has a second evaluation to repeat a verdict'
        : 'pool: candidates with two or more runs that passed every one / candidates with two or more runs',
    },
    {
      objective: 'latency',
      unit: 'milliseconds',
      value: rollouts === 0 ? null : wallTimeMs / rollouts,
      source: rollouts === 0
        ? 'not measurable: no recorded spend names an evaluated rollout (SpendRecord.rollouts)'
        : 'spends: SpendRecord.wallTimeMs / SpendRecord.rollouts',
    },
    {
      objective: 'cost',
      unit: 'tokens',
      value: tokens,
      source: 'spends: SpendRecord.tokens',
    },
    {
      objective: 'memory-footprint',
      unit: 'bytes',
      value: null,
      source: 'not measurable: no store records the memory a candidate evaluation held',
    },
    {
      objective: 'context-usage',
      unit: 'tokens',
      value: null,
      source: 'not measurable: no store records the context tokens a candidate evaluation carried',
    },
    {
      objective: 'background-compute',
      unit: 'tokens',
      value: background,
      source: background === null
        ? 'not measurable: no recorded spend attributes background compute to the batch (SpendRecord.backgroundTokens)'
        : 'spends: SpendRecord.backgroundTokens',
    },
  ]
}
