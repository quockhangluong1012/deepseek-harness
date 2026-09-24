/**
 * S9 evaluation-tier gate: refuse a new scoring run once the skill's daily or
 * weekly evolution-budget ceiling is spent, checked before the run rather
 * than after. Distinct from {@link EvolutionOptimizer}'s post-hoc
 * `recordBudget`, which records a completed staged run's total cost under
 * its own one-off batch id for the allocation policy to learn from; this
 * gate keys two long-lived batches per skill (`daily`, `weekly`) that
 * accumulate every scoring run's spend across the skill's whole history, and
 * it can refuse before a run happens.
 * @module @deepseek-ai/dsh-evolution-optimizer/tiers
 */

import type {} from '@deepseek-ai/dsh-evolution-budget'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillEvaluation } from '@deepseek-ai/dsh-evolution-scorer'
import { scoreVariant, type ScoreVariantDeps } from './evaluate.ts'

/** Two-digit zero pad for a date/week component. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** The skill's ceiling batch id for the UTC calendar day `at` falls in. */
export function dailyBatchId(skill: string, at: Date): string {
  return `evolution-optimizer:${skill}:daily:${at.toISOString().slice(0, 10)}`
}

/**
 * The skill's ceiling batch id for the ISO-8601 week `at` falls in
 * (Monday-based, `YYYY-Www`).
 */
export function weeklyBatchId(skill: string, at: Date): string {
  const isoDay = (at.getUTCDay() + 6) % 7 // Monday=0 .. Sunday=6
  const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - isoDay + 3))
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86400000 + 1) / 7)
  return `evolution-optimizer:${skill}:weekly:${thursday.getUTCFullYear()}-W${pad(week)}`
}

/**
 * Score one variant behind the tier-2 ceiling gate: refuse before the run
 * when the skill's daily or weekly evolution-budget batch is already spent,
 * else score it and record the spend against both. Absent `evolutionBudget`
 * skips the gate entirely — every ceiling is unconfigured, not exceeded.
 * @param ctx - host context; only `ctx.evolutionBudget` is read, when mounted.
 * @param deps - scorer, skill, scenarios, agent, runner.
 * @param body - the SKILL.md body to score.
 * @returns the scorer's evaluation, or a tier-2 refusal naming the spent ceiling.
 */
export async function scoreVariantGated(
  ctx: Context,
  deps: ScoreVariantDeps,
  body: string,
): Promise<SkillEvaluation> {
  const budget = ctx.get('evolutionBudget')
  if (budget === undefined) return scoreVariant(deps, body)
  const at = new Date()
  const daily = dailyBatchId(deps.skill, at)
  const weekly = weeklyBatchId(deps.skill, at)
  for (const batchId of [daily, weekly]) {
    if (!budget.batches(deps.skill).some(row => row.batchId === batchId)) {
      await budget.allocate({ batchId, taskClass: deps.skill, candidateClass: 'standard' })
    }
  }
  if (!budget.withinBudget(daily) || !budget.withinBudget(weekly)) {
    return {
      status: 'skipped',
      skill: deps.skill,
      reason: `the daily or weekly evolution-budget ceiling for '${deps.skill}' is spent`,
    }
  }
  const evaluation = await scoreVariant(deps, body)
  if (evaluation.status === 'evaluated') {
    const spend = { tokens: evaluation.score.tokens, wallTimeMs: evaluation.score.wallTimeMs, rollouts: 1 }
    await budget.spend(daily, spend)
    await budget.spend(weekly, spend)
  }
  return evaluation
}
