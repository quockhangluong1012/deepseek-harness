/**
 * What one promotion records and refuses to record: the verdict its two arms'
 * measurements support, the evaluation context both arms were measured under
 * (§14.6), the attempts a triple was measured with, and the digest the ledger
 * identifies a body by. Pure, so specs drive the arithmetic without a run. The
 * line diff a promotion records is `lineDiff` from
 * `@deepseek-ai/dsh-evolution-lineage`, which owns the revision arithmetic its
 * policy chain is built from.
 * @module @deepseek-ai/dsh-evolution-optimizer/lineage
 */

import { createHash } from 'node:crypto'
import type { ExperimentOutcome } from '@deepseek-ai/dsh-evolution-lineage'
import type { SkillScore } from '@deepseek-ai/dsh-evolution-scorer'
import type { EvaluationContext, EvaluationDimension } from './types.ts'

/**
 * SHA-256 of one skill body, so the ledger identifies the exact text a run
 * scored without storing the body itself.
 * @param text - the body to digest.
 * @returns the lowercase hex digest.
 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Attempts per scenario a triple was measured with. A run whose scenarios ran
 * different attempt counts has no single number, so the fewest any scored
 * scenario took is the count a comparison may rely on; a score with no
 * scenario records reports zero.
 * @param score - the aggregated triple.
 * @returns the attempt count two triples must share to be comparable.
 */
export function attemptsPerScenario(score: SkillScore): number {
  const counts = score.scores.map(record => record.samples.length)
  return counts.length === 0 ? 0 : Math.min(...counts)
}

/**
 * The lineage verdict one promotion's measurement supports: `improved` when the
 * winner passed where the baseline did not, `regressed` when the baseline
 * passed where the winner did not, and `inconclusive` when the pass state was
 * unchanged and only the token epsilon decided the pick — selection measures
 * pass state first (S9.3), so a cost-only win is not a pass improvement the
 * record may claim. The promotion gate reaches this record only with a winner
 * that dominated the baseline, so a run reports `regressed` here only if a
 * caller records a comparison the gate never made.
 * @param baseline - the score the baseline measured under the run's harness.
 * @param winner - the score the winner measured under the same harness.
 * @returns the measured outcome for the lineage envelope.
 */
export function measuredOutcome(baseline: { pass: boolean }, winner: { pass: boolean }): ExperimentOutcome {
  const delta = Number(winner.pass) - Number(baseline.pass)
  if (delta > 0) return 'improved'
  return delta < 0 ? 'regressed' : 'inconclusive'
}

/** Deployment facts one run's evaluation context is built from. */
export interface PromotionContextOptions {
  /** Scoring-semantics version both arms were measured under. */
  scorerVersion: number
  /** Agent composition every attempt of both arms booted. */
  model: string
  /** Token and wall-time ceilings both arms were scored under, zero meaning unbounded. */
  budget: { tokens: number; wallTimeMs: number }
}

/** What one promotion's two arms share, and what they do not. */
export interface PromotionContextCheck {
  /**
   * The context both arms were measured under. Its benchmark, model, and task
   * set come from the baseline — the arm a candidate has to beat — so a run
   * that records this records the conditions the winner was required to meet.
   */
  context: EvaluationContext
  /** Dimensions the two arms disagree on, in canonical order; empty when a promotion may land. */
  mismatch: readonly EvaluationDimension[]
}

/**
 * Build the evaluation context one promotion's two arms were measured under,
 * and name the dimensions they disagree on (§14.6). The benchmark is the
 * scorer version plus a digest of the fixture content each arm's scenarios
 * were read from, so a corpus regenerated between the two arms reads as a
 * different benchmark rather than a score to compare. The model and the budget
 * are run-level facts — one composition and one ceiling are used for both arms
 * — and are recorded rather than compared.
 * @param baseline - the re-scored baseline's triple.
 * @param winner - the winning candidate's triple, measured under the same harness.
 * @param options - scorer version, agent composition, and budget ceilings.
 * @returns the shared context plus the differing dimensions.
 */
export function promotionContext(
  baseline: SkillScore,
  winner: SkillScore,
  options: PromotionContextOptions,
): PromotionContextCheck {
  const baselineArm = armIdentity(baseline, options.scorerVersion)
  const winnerArm = armIdentity(winner, options.scorerVersion)
  const mismatch: EvaluationDimension[] = []
  if (baselineArm.benchmark !== winnerArm.benchmark) mismatch.push('benchmark')
  if (JSON.stringify(baselineArm.tasks) !== JSON.stringify(winnerArm.tasks)) mismatch.push('tasks')
  return {
    mismatch,
    context: {
      benchmark: baselineArm.benchmark,
      model: options.model,
      budget: { tokens: options.budget.tokens, wallTimeMs: options.budget.wallTimeMs },
      tasks: baselineArm.tasks,
      attempts: { baseline: baselineArm.attempts, winner: winnerArm.attempts },
    },
  }
}

/**
 * One arm's measured evaluation identity: the benchmark its scenario records
 * were read from (scorer version plus a digest of their fixture content, so a
 * regenerated corpus reads as a different benchmark), the task set it covered
 * in scored order, and the attempts per scenario it bought.
 */
function armIdentity(
  score: SkillScore,
  scorerVersion: number,
): { benchmark: string; tasks: readonly string[]; attempts: number } {
  const fixtures = score.scores
    .map(record => `${record.scenario}:${record.fixtureDigest}`)
    .sort()
  return {
    benchmark: `scorer-v${scorerVersion}:${digestOf(fixtures.join('\n'))}`,
    tasks: score.scores.map(record => record.scenario),
    attempts: attemptsPerScenario(score),
  }
}
