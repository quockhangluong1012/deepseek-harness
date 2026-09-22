/**
 * Pure helpers for evaluator-strategy evolution: the running statistics
 * update from one verdict/ground-truth pair, the smoothed corroboration
 * weight, and the ranking that says which evaluator to trust for a task class.
 * No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-evaluator-strategy/src/strategy
 */

import type { EvaluatorOutcome, EvaluatorStrategy, StrategyRanking, TaskClass } from './types.ts'

/** The storage key of one evaluator's strategy: evaluator and class joined. */
export function strategyKey(evaluator: string, taskClass: TaskClass): string {
  return `${evaluator}\0${taskClass}`
}

/**
 * The smoothed corroboration weight over the independent samples: a beta
 * prior of one corroboration in two observations, so one lucky match cannot
 * outrank a long record and no independent sample weighs nothing at all.
 * @param corroborations - independent verdicts that matched the ground truth.
 * @param independentSamples - verdicts judged against an independent ground truth.
 * @returns the weight, 0 with no independent evidence.
 */
export function weightOf(corroborations: number, independentSamples: number): number {
  return independentSamples === 0 ? 0 : (corroborations + 1) / (independentSamples + 2)
}

/**
 * Advance one evaluator's statistics with one verdict/ground-truth pair. Only
 * an independent pair counts toward corroboration: a verdict checked against
 * itself corroborates nothing, so it raises the sample count without moving
 * the weight.
 * @param current - the statistics to advance, or undefined for the first pair.
 * @param outcome - the verdict and its ground truth.
 * @param at - ISO-8601 instant of the verdict.
 * @returns the advanced statistics.
 */
export function updatedStrategy(
  current: EvaluatorStrategy | undefined,
  outcome: EvaluatorOutcome,
  at: string,
): EvaluatorStrategy {
  const samples = (current?.samples ?? 0) + 1
  const independentSamples = (current?.independentSamples ?? 0) + (outcome.independent ? 1 : 0)
  const corroborations = (current?.corroborations ?? 0)
    + (outcome.independent && outcome.verdict === outcome.groundTruth ? 1 : 0)
  return {
    evaluator: outcome.evaluator,
    taskClass: outcome.taskClass,
    samples,
    independentSamples,
    corroborations,
    weight: weightOf(corroborations, independentSamples),
    lastAt: at,
  }
}

/**
 * Rank one task class's evaluators by their smoothed corroboration weight,
 * weight descending with independent-sample count and then evaluator
 * ascending as tie-breaks.
 * @param strategies - every recorded strategy statistics row.
 * @param taskClass - the task class to rank evaluators for.
 * @returns the ranked evaluators, most trustworthy first.
 */
export function rankStrategies(
  strategies: readonly EvaluatorStrategy[],
  taskClass: TaskClass,
): StrategyRanking[] {
  return strategies
    .filter(row => row.taskClass === taskClass)
    .map(row => ({
      evaluator: row.evaluator,
      samples: row.samples,
      independentSamples: row.independentSamples,
      corroborations: row.corroborations,
      weight: row.weight,
      reason: describeRanking(row),
    }))
    .sort((left, right) =>
      right.weight - left.weight
      || right.independentSamples - left.independentSamples
      || left.evaluator.localeCompare(right.evaluator))
}

/**
 * The evaluator to trust for one task class: the best-ranked evaluator with at
 * least the minimum number of independent samples. Yields undefined while no
 * evaluator has that much independent evidence.
 * @param rankings - the ranked evaluators, most trustworthy first.
 * @param minimumSamples - independent samples an evaluator must have.
 * @returns the recommended evaluator, or undefined.
 */
export function recommendStrategy(
  rankings: readonly StrategyRanking[],
  minimumSamples: number,
): StrategyRanking | undefined {
  return rankings.find(entry => entry.independentSamples >= minimumSamples)
}

/**
 * Render why one evaluator ranks as it does, naming the numbers.
 * @param row - the statistics to describe.
 * @returns the reason sentence.
 */
function describeRanking(row: EvaluatorStrategy): string {
  const rate = row.independentSamples === 0
    ? 'no independent evidence'
    : `${row.corroborations}/${row.independentSamples} independent verdicts corroborated`
  return `${rate} (${row.samples} verdicts recorded), weight ${row.weight.toFixed(3)}`
}