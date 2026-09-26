/**
 * Paired significance for the promotion gate: the statistic a candidate must
 * clear before a run may call it better than the baseline it was measured
 * against (amendment S9). The scorer already records one outcome per scenario
 * for each arm, so the comparison is paired scenario by scenario — a scenario
 * the winner passed where the baseline failed is a win, the reverse a loss,
 * and agreeing scenarios carry no information about the difference between
 * the arms.
 *
 * One statistic, named on the record: the exact two-sided sign test over the
 * discordant pairs, which needs no distributional assumption and is exact at
 * the sample sizes a skill's scenario corpus actually reaches. A record
 * reader sees `pValue`, the `confidence` it was decided at, and the win/loss
 * tally behind it, so the decision is auditable rather than a boolean.
 *
 * Two arms with no discordant pair carry no pass-rate evidence at all (the
 * sign test is undefined there); the relative token epsilon in `pareto.ts` is
 * then the only axis that separated them, exactly as it was before this gate
 * existed. Pure, so specs drive the arithmetic without a run.
 * @module @deepseek-ai/dsh-evolution-optimizer/significance
 */

import type { SkillScore } from '@deepseek-ai/dsh-evolution-scorer'

/** The paired comparison one promotion decision was decided on. */
export interface PairedSignificance {
  /** The one statistic this record carries, so `pValue` has a stated meaning. */
  method: 'paired-sign-test'
  /** Confidence level the verdict was decided at, in (0, 1): a run requires `pValue <= 1 - confidence`. */
  confidence: number
  /** Paired scenarios the winner passed and the baseline did not. */
  wins: number
  /** Paired scenarios the baseline passed and the winner did not. */
  losses: number
  /** Paired scenarios both arms agreed on; they carry no evidence about the difference. */
  ties: number
  /**
   * Exact two-sided p-value over the discordant pairs: twice the probability
   * of at least this lopsided a split under the null hypothesis that each
   * discordant scenario is equally likely to favor either arm. One when no
   * pair is discordant, because there is nothing to test.
   */
  pValue: number
  /** Whether the discordant pairs favor the winner at `confidence`; false when none are discordant. */
  significant: boolean
}

/**
 * Compare one winner against its baseline on the per-scenario outcomes both
 * arms recorded. Scenarios only one arm scored are not pairs and are left out
 * of the tally: an unpaired scenario cannot say anything about a difference
 * between the two arms.
 * @param baseline - the re-scored baseline's triple, carrying its per-scenario records.
 * @param winner - the winning candidate's triple, measured under the same harness.
 * @param confidence - confidence level the verdict is decided at, in (0, 1).
 * @returns the paired tally, its p-value, and the significance verdict.
 */
export function pairedSignTest(
  baseline: SkillScore,
  winner: SkillScore,
  confidence: number,
): PairedSignificance {
  const baselineByScenario = new Map(baseline.scores.map(record => [record.scenario, record.pass]))
  let wins = 0
  let losses = 0
  let ties = 0
  for (const record of winner.scores) {
    const baselinePass = baselineByScenario.get(record.scenario)
    if (baselinePass === undefined) continue
    if (baselinePass === record.pass) {
      ties += 1
      continue
    }
    if (record.pass) wins += 1
    else losses += 1
  }
  const pValue = twoSidedSignTestP(wins, losses)
  return {
    method: 'paired-sign-test',
    confidence,
    wins,
    losses,
    ties,
    pValue,
    significant: wins + losses > 0 && pValue <= 1 - confidence,
  }
}

/**
 * Exact two-sided p-value of a sign test over `wins + losses` discordant pairs
 * that split as lopsidedly as the observed one, under the fair-coin null. The
 * binomial terms are accumulated in log space so a large scenario corpus
 * neither overflows the coefficient nor underflows the probability.
 * @param wins - discordant pairs favoring the winner.
 * @param losses - discordant pairs favoring the baseline.
 * @returns the two-sided p-value in [0, 1]; one when no pair is discordant.
 */
function twoSidedSignTestP(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const tail = Math.min(wins, losses)
  let logTerm = 0
  let sum = 0
  for (let k = 0; k <= tail; k += 1) {
    sum += Math.exp(logTerm)
    logTerm += Math.log(n - k) - Math.log(k + 1)
  }
  return Math.min(1, 2 * sum * Math.exp(-n * Math.LN2))
}
