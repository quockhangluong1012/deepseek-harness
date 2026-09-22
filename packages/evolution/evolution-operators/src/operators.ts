/**
 * Pure helpers for mutation-operator evolution: the canonical operator
 * catalog, the running statistics update from one measured outcome, and the
 * exploration-adjusted ranking that decides which operator to try next on an
 * artifact class. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-operators/src/operators
 */

import type { MutationOperator, OperatorOutcome, OperatorRanking, OperatorStats } from './types.ts'

/** The eight §8 mutation operators, in canonical order. */
export const MUTATION_OPERATORS: readonly MutationOperator[] = [
  'rewrite',
  'add-step',
  'remove-step',
  'change-tool',
  'change-retrieval',
  'change-evaluator',
  'merge-candidates',
  'adversarial-patch',
]

/** The storage key of one operator's statistics: operator and class joined. */
export function statsKey(operator: MutationOperator, artifactClass: string): string {
  return `${operator}\0${artifactClass}`
}

/**
 * Advance one operator's statistics with one measured outcome. Acceptance and
 * the weighted mean delta are exact accumulations; the regression rate is the
 * exact share of negative deltas over the new attempt count.
 * @param current - the statistics to advance, or undefined for the first use.
 * @param outcome - the measured outcome to fold in.
 * @param at - ISO-8601 instant of the outcome.
 * @returns the advanced statistics.
 */
export function updatedStats(
  current: OperatorStats | undefined,
  outcome: OperatorOutcome,
  at: string,
): OperatorStats {
  const attempts = (current?.attempts ?? 0) + 1
  const accepted = (current?.accepted ?? 0) + (outcome.accepted ? 1 : 0)
  const meanDelta = current === undefined
    ? outcome.delta
    : current.meanDelta + (outcome.delta - current.meanDelta) / attempts
  const priorRegressions = current === undefined ? 0 : current.regressionRate * current.attempts
  const regressions = priorRegressions + (outcome.delta < 0 ? 1 : 0)
  return {
    operator: outcome.operator,
    artifactClass: outcome.artifactClass,
    attempts,
    accepted,
    meanDelta,
    regressionRate: regressions / attempts,
    lastAt: at,
  }
}

/**
 * The exploration-adjusted score of one operator's statistics: a beta-prior
 * smoothed acceptance rate plus an exploration bonus that decays with sample
 * count, so a proven operator outranks an untried one once it has evidence,
 * while an operator that keeps failing yields to operators never tried yet.
 * @param stats - the statistics to score, or undefined for an untried operator.
 * @param exploration - the exploration bonus weight (0 to 1).
 * @returns the score.
 */
export function scoreOf(stats: OperatorStats | undefined, exploration: number): number {
  const attempts = stats?.attempts ?? 0
  const accepted = stats?.accepted ?? 0
  const smoothed = (accepted + 1) / (attempts + 2)
  const bonus = exploration * Math.sqrt(1 / (attempts + 1))
  return smoothed + bonus
}

/**
 * Rank every operator for one artifact class by its exploration-adjusted
 * score, score descending with canonical-order and then identity tie-breaks.
 * The eight canonical operators always enter the ranking with their prior
 * score when untried, and any observed non-canonical operator joins the
 * ranking with its real statistics, so the ranking always names a next
 * operator to try and never hides an operator a deployment actually uses.
 * @param stats - every recorded statistics row for the artifact class.
 * @param artifactClass - the artifact class to rank operators for.
 * @param exploration - the exploration bonus weight.
 * @returns the ranked operators, best first.
 */
export function rankOperators(
  stats: readonly OperatorStats[],
  artifactClass: string,
  exploration: number,
): OperatorRanking[] {
  const byOperator = new Map(stats.map(row => [row.operator, row]))
  const observed = stats.map(row => row.operator)
  const operators = [...new Set([...MUTATION_OPERATORS, ...observed])]
  return operators
    .map(operator => {
      const row = byOperator.get(operator)
      const attempts = row?.attempts ?? 0
      const accepted = row?.accepted ?? 0
      return {
        operator,
        attempts,
        acceptanceRate: attempts === 0 ? 0.5 : accepted / attempts,
        meanDelta: row?.meanDelta ?? 0,
        score: scoreOf(row, exploration),
        reason: describeRanking(operator, artifactClass, row, exploration),
      }
    })
    .sort((left, right) => {
      const leftOrder = canonicalOrder(left.operator)
      const rightOrder = canonicalOrder(right.operator)
      return right.score - left.score
        || leftOrder - rightOrder
        || left.operator.localeCompare(right.operator)
    })
}

/** The ranking position of one operator: canonical order, then observed ones. */
function canonicalOrder(operator: string): number {
  const index = MUTATION_OPERATORS.indexOf(operator)
  return index === -1 ? MUTATION_OPERATORS.length : index
}

/**
 * The best operator to try next on an artifact class: the top of the ranking,
 * which is a proven leader when evidence exists and the canonical first
 * operator when nothing is recorded yet.
 * @param rankings - the ranked operators, best first.
 * @returns the recommended operator.
 */
export function recommendOperator(rankings: readonly OperatorRanking[]): OperatorRanking | undefined {
  return rankings[0]
}

/**
 * Render why one operator ranks as it does, naming the numbers: acceptance,
 * mean delta, regressions, and the exploration bonus.
 * @param operator - the operator being described.
 * @param artifactClass - the artifact class the ranking covers.
 * @param stats - the operator's statistics, or undefined when untried.
 * @param exploration - the exploration bonus weight used in the score.
 * @returns the reason sentence.
 */
function describeRanking(
  operator: MutationOperator,
  artifactClass: string,
  stats: OperatorStats | undefined,
  exploration: number,
): string {
  if (stats === undefined) {
    return `untried on '${artifactClass}'; prior score ranks it here`
  }
  const regressions = stats.regressionRate * stats.attempts
  const bonus = (exploration * Math.sqrt(1 / (stats.attempts + 1))).toFixed(3)
  return `accepted ${stats.accepted}/${stats.attempts} (${(stats.accepted / stats.attempts).toFixed(2)}), mean delta ${stats.meanDelta.toFixed(2)}, ${regressions.toFixed(0)} regressions, exploration +${bonus} — ${operator} on '${artifactClass}'`
}