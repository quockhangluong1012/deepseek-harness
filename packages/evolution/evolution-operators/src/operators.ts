/**
 * Pure helpers for mutation-operator evolution: the canonical operator
 * catalog, the running statistics update from one measured outcome, and the
 * exploration-adjusted ranking that decides which operator to try next on an
 * artifact class, nudged by the verdicts recorded for the instruction that
 * class holds (§9). No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-operators/src/operators
 */

import { instructionAdjustment } from './instructions.ts'
import type { MutationOperator, OperatorInstruction, OperatorOutcome, OperatorRanking, OperatorStats } from './types.ts'

/**
 * One operator of the canonical vocabulary: the stable id a deployment selects
 * in Config and the instruction line a request opened with it carries.
 */
export interface MutationOperatorSpec {
  /** Stable id a deployment selects in Config. */
  id: MutationOperator
  /** Instruction line appended to the mutation request header. */
  instruction: string
}

/**
 * The canonical mutation-operator vocabulary, in canonical order: the
 * single-body repairs a run may draw a candidate from. It is the one list both
 * consumers read — this store ranks the outcomes it records under these ids,
 * and `@deepseek-ai/dsh-evolution-optimizer` sends the instruction its
 * portfolio holds — so an operator the ranking credits is an operator a run can
 * actually select.
 *
 * Selection guide: `rewrite` clarifies without changing behavior; `compress`
 * shortens a body the evidence shows is ignored for length; `guard` adds the
 * missing precondition, refusal, or validation; `exemplify` teaches by example;
 * `generalize` widens a rule that only covers the failing instance;
 * `decompose` splits an uncheckable procedure into steps; `compose` merges
 * overlapping rules; `reorder` moves the implicated check earlier without
 * touching rule text; `remove-step` deletes a step the evidence shows never
 * fires; `change-tool` swaps the implicated tool call; `change-retrieval`
 * changes only what the body looks up; `change-evaluator` changes only how the
 * body checks its own result. Three members of the evolutionary-harness
 * specification's portfolio stay out: `merge-two-candidates` needs two input
 * bodies and a request frame carries one, `adversarial-patch` belongs to the
 * contamination review rather than to repair mutation, and `specialize` has no
 * instruction here.
 */
export const MUTATION_OPERATOR_CATALOG: readonly MutationOperatorSpec[] = [
  { id: 'rewrite', instruction: 'Rewrite the body for clarity and ordering; change only what the evidence implicates.' },
  { id: 'compress', instruction: 'Cut the body to the shortest text that still states every rule the evidence shows matters.' },
  { id: 'guard', instruction: 'Add the precondition, refusal, or validation the evidence implicates, and nothing else.' },
  { id: 'exemplify', instruction: 'Add one worked example per rule the evidence implicates; drop nothing that already works.' },
  { id: 'generalize', instruction: 'Widen each rule the evidence implicates so it covers the failure class, not just the failing instance.' },
  { id: 'decompose', instruction: 'Split the procedure the evidence implicates into separately checkable steps; keep every existing rule.' },
  { id: 'compose', instruction: 'Merge duplicated or overlapping rules the evidence implicates into one rule that states both.' },
  { id: 'reorder', instruction: 'Move the check the evidence implicates earlier in the procedure; change no rule text.' },
  { id: 'remove-step', instruction: 'Delete the step the evidence shows never fires or always passes; keep everything else byte-identical.' },
  { id: 'change-tool', instruction: 'Replace the tool call the evidence implicates with the tool that actually answers the question.' },
  { id: 'change-retrieval', instruction: 'Change only what the body retrieves — queries, sources, or lookup order — as the evidence implicates.' },
  { id: 'change-evaluator', instruction: 'Change only how the body checks its own result — thresholds, assertions, or verification steps — as the evidence implicates.' },
]

/** The canonical operator ids of {@link MUTATION_OPERATOR_CATALOG}, in canonical order. */
export const MUTATION_OPERATORS: readonly MutationOperator[] = MUTATION_OPERATOR_CATALOG.map(spec => spec.id)

/**
 * The storage key of one operator's statistics: operator and class joined.
 * @param operator - the mutation operator.
 * @param artifactClass - the artifact class the statistics cover.
 * @returns the storage key.
 */
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
 * The instruction evidence that adjusts one class's ranking (§9).
 */
export interface RankOptions {
  /** The instruction rows recorded for the artifact class. */
  instructions: readonly OperatorInstruction[]
  /** Weight of the bounded instruction adjustment (0 to 1). */
  instructionWeight: number
}

/**
 * Rank every operator for one artifact class by its exploration-adjusted
 * score, score descending with canonical-order and then identity tie-breaks.
 * The canonical operators of {@link MUTATION_OPERATOR_CATALOG} always enter the
 * ranking with their prior score when untried, and any observed non-canonical
 * operator joins the ranking with its real statistics, so the ranking always
 * names a next operator to try and never hides an operator a deployment
 * actually uses.
 * Recorded instruction verdicts nudge the score by a bounded amount, which is
 * what lets a mutation strategy move: an operator whose proposed instruction
 * was rejected yields to one whose proposal held.
 * @param stats - every recorded statistics row for the artifact class.
 * @param artifactClass - the artifact class to rank operators for.
 * @param exploration - the exploration bonus weight.
 * @param options - the class's recorded instructions and their weight, when a deployment records any.
 * @returns the ranked operators, best first.
 */
export function rankOperators(
  stats: readonly OperatorStats[],
  artifactClass: string,
  exploration: number,
  options?: RankOptions,
): OperatorRanking[] {
  const byOperator = new Map(stats.map(row => [row.operator, row]))
  const instructionByOperator = new Map((options?.instructions ?? []).map(row => [row.operator, row]))
  const observed = stats.map(row => row.operator)
  const operators = [...new Set([...MUTATION_OPERATORS, ...observed])]
  return operators
    .map((operator) => {
      const row = byOperator.get(operator)
      const attempts = row?.attempts ?? 0
      const accepted = row?.accepted ?? 0
      const adjustment = instructionAdjustment(instructionByOperator.get(operator), options?.instructionWeight ?? 0)
      return {
        operator,
        attempts,
        acceptanceRate: attempts === 0 ? 0.5 : accepted / attempts,
        meanDelta: row?.meanDelta ?? 0,
        instructionAdjustment: adjustment,
        score: scoreOf(row, exploration) + adjustment,
        reason: describeRanking(operator, artifactClass, row, exploration, adjustment),
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
 * mean delta, regressions, the exploration bonus, and the instruction nudge
 * when verdicts contributed one.
 * @param operator - the operator being described.
 * @param artifactClass - the artifact class the ranking covers.
 * @param stats - the operator's statistics, or undefined when untried.
 * @param exploration - the exploration bonus weight used in the score.
 * @param adjustment - the instruction adjustment added to the score.
 * @returns the reason sentence.
 */
function describeRanking(
  operator: MutationOperator,
  artifactClass: string,
  stats: OperatorStats | undefined,
  exploration: number,
  adjustment: number,
): string {
  const instruction = adjustment === 0 ? '' : `, instruction ${adjustment > 0 ? '+' : ''}${adjustment.toFixed(3)}`
  if (stats === undefined) {
    return `untried on '${artifactClass}'; prior score ranks it here${instruction}`
  }
  const regressions = stats.regressionRate * stats.attempts
  const bonus = (exploration * Math.sqrt(1 / (stats.attempts + 1))).toFixed(3)
  return `accepted ${stats.accepted}/${stats.attempts} (${(stats.accepted / stats.attempts).toFixed(2)}), mean delta ${stats.meanDelta.toFixed(2)}, ${regressions.toFixed(0)} regressions, exploration +${bonus}${instruction} — ${operator} on '${artifactClass}'`
}
