/**
 * S9 evaluation-tier gate: refuse a new scoring run once the skill's daily or
 * weekly evolution-budget ceiling is spent, checked before the run rather
 * than after. Distinct from {@link EvolutionOptimizer}'s post-hoc
 * `recordBudget`, which records a completed staged run's total cost under
 * its own one-off batch id for the allocation policy to learn from; this
 * gate keys two long-lived batches per skill (`daily`, `weekly`) that
 * accumulate every scoring run's spend across the skill's whole history, and
 * it can refuse before a run happens. The batches themselves, and the refusal
 * both the scoring and the mutation paths read, are `evolution-budget`'s
 * {@link openCeiling}.
 * @module @deepseek-ai/dsh-evolution-optimizer/tiers
 */

import { createHash } from 'node:crypto'
import {
  dailyBatchId as budgetDailyBatchId,
  openCeiling,
  weeklyBatchId as budgetWeeklyBatchId,
} from '@deepseek-ai/dsh-evolution-budget'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillEvaluation } from '@deepseek-ai/dsh-evolution-scorer'
import { scoreVariant, type ScoreVariantDeps } from './evaluate.ts'

/** The skill's ceiling batch id for the UTC calendar day `at` falls in. */
export function dailyBatchId(skill: string, at: Date): string {
  return budgetDailyBatchId('evolution-optimizer', skill, at)
}

/**
 * The skill's ceiling batch id for the ISO-8601 week `at` falls in
 * (Monday-based, `YYYY-Www`).
 */
export function weeklyBatchId(skill: string, at: Date): string {
  return budgetWeeklyBatchId('evolution-optimizer', skill, at)
}

/**
 * Score one variant behind the tier-2 ceiling gate: refuse before the run
 * when the skill's daily or weekly evolution-budget batch is already spent,
 * else score it and record the spend against both. Absent `evolutionBudget`
 * skips the gate entirely — every ceiling is unconfigured, not exceeded.
 * @param ctx - host context; only `ctx.evolutionBudget` is read, when mounted.
 * @param deps - scorer, skill, scenarios, agent, runner.
 * @param body - the SKILL.md body to score.
 * @param attempts - fresh-process attempt-count override forwarded to the scorer; see {@link scoreVariantTiered}.
 * @returns the scorer's evaluation, or a tier-2 refusal naming the spent ceiling.
 */
export async function scoreVariantGated(
  ctx: Context,
  deps: ScoreVariantDeps,
  body: string,
  attempts?: number,
): Promise<SkillEvaluation> {
  const opening = await openCeiling(ctx, 'evolution-optimizer', deps.skill, new Date())
  if (opening.kind === 'refused') return { status: 'skipped', skill: deps.skill, reason: opening.reason }
  const evaluation = await scoreVariant(deps, body, attempts)
  if (opening.kind === 'open' && evaluation.status === 'evaluated') {
    const spend = { tokens: evaluation.score.tokens, wallTimeMs: evaluation.score.wallTimeMs, rollouts: 1 }
    for (const batchId of opening.batchIds) await opening.budget.spend(batchId, spend)
  }
  return evaluation
}

/**
 * S9 tier-1 content key: a scenario's model request for a fixed skill,
 * scenario set, and candidate body is what the recorded fixture corpus was
 * authored against, so hashing `(skill, scenarios, body)` stands in for
 * hashing the normalized request itself (system text, messages, tool
 * schemas) without reconstructing that request outside the fresh-process
 * harness.
 * @param skill - skill the scenarios exercise.
 * @param scenarios - scenario directory names the evaluation runs.
 * @param body - candidate SKILL.md body.
 * @returns a stable hex digest identifying the triple.
 */
export function tierOneKey(skill: string, scenarios: readonly string[], body: string): string {
  const canonical = JSON.stringify({ skill, scenarios: [...scenarios].sort(), body })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Score one variant behind the S9 tier gate: a body whose content key
 * matches the run's own starting body is exactly what the corpus fixtures
 * were recorded against, so one deterministic replay run (tier 1) is
 * trustworthy; a content-key miss means the candidate changed what the
 * fixture already validates, so it escalates to the scorer's full configured
 * attempt count (tier 2), still behind the tier-2 budget-ceiling gate.
 * `startingBody` is deliberately the run's own baseline, not a persisted
 * cache: a body's measured behavior is re-verified every time it is
 * scored, never reused across separate optimizer runs, so a promotion
 * decision never rests on a stale sample.
 * @param ctx - host context; forwarded to the tier-2 gate.
 * @param deps - scorer, skill, scenarios, agent, runner.
 * @param body - the SKILL.md body to score.
 * @param startingBody - the skill body this optimizer run started from.
 * @returns the scorer's evaluation, or a tier-2 refusal naming the spent ceiling.
 */
export async function scoreVariantTiered(
  ctx: Context,
  deps: ScoreVariantDeps,
  body: string,
  startingBody: string,
): Promise<SkillEvaluation> {
  const tierOne = tierOneKey(deps.skill, deps.scenarios, body) === tierOneKey(deps.skill, deps.scenarios, startingBody)
  return scoreVariantGated(ctx, deps, body, tierOne ? 1 : undefined)
}
