/**
 * Evaluator-strategy evolution (`ctx.evolutionEvaluatorStrategy`): a durable
 * store of per-evaluator and per-task-class trust statistics (§9) — verdict
 * samples, independent corroborations, and the smoothed weight — with the
 * ranking that says which evaluator to trust for a task class. The optimizer
 * records every staged write's scorer verdict paired with its holdout ground
 * truth through the optional recorder seam, and `/evaluator-strategy` reads
 * the statistics and the ranking. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-evaluator-strategy
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-model-routes'
import z from 'zod'
import { evaluatorStrategyDomainSpec } from './spec.ts'
import { rankStrategies, recommendStrategy, strategyKey, updatedStrategy } from './strategy.ts'
import type { EvaluatorOutcome, EvaluatorStrategy, StrategyRanking, TaskClass } from './types.ts'

export type * from './types.ts'
export { judgeIndependence, rankStrategies, recommendStrategy, strategyKey, updatedStrategy, weightOf } from './strategy.ts'
export { evaluatorStrategyDomainSpec, evaluatorStrategyRow } from './spec.ts'

/**
 * Deployment choices of the evaluator-strategy store; an omitted field takes
 * its default.
 */
export interface Config {
  /** Independent samples an evaluator needs before it may be recommended; defaults to 3. */
  minimumSamples?: number
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Independent samples an evaluator needs before it may be recommended. */
  minimumSamples: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { minimumSamples = 3 } = config
  return { minimumSamples }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-evaluator trust statistics with the per-class ranking. */
    evolutionEvaluatorStrategy: EvolutionEvaluatorStrategy
  }
}

/**
 * Evaluator-strategy store over durable statistics rows. Opens the
 * `evolution_evaluator_strategy` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionEvaluatorStrategy extends Service {
  static inject = ['storageDomain']

  /** Deployment choice of the recommendation's minimum independent samples. */
  static Config = z.object({
    minimumSamples: z.number().int().min(0).default(3),
  })

  private readonly resolved: ResolvedConfig

  private strategyTable?: KvTable<string, EvaluatorStrategy>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated recommendation choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionEvaluatorStrategy')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(evaluatorStrategyDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-evaluator-strategy.domainClose')
    this.strategyTable = domain.table('strategies')
  }

  /**
   * Record one verdict/ground-truth pair, upserting the evaluator's
   * statistics for its task class. The stored instant is now.
   * @param outcome - the verdict and the ground truth it is judged against.
   * @returns the updated statistics.
   */
  async observe(outcome: EvaluatorOutcome): Promise<EvaluatorStrategy> {
    const key = strategyKey(outcome.evaluator, outcome.taskClass)
    const next = updatedStrategy(this.strategyTable?.get(key), outcome, new Date().toISOString())
    await this.requireStrategies().put(key, next)
    return structuredClone(next)
  }

  /**
   * List every recorded statistics row, optionally filtered by task class, in
   * evaluator order then task-class order.
   * @param taskClass - optional task-class filter.
   * @returns the rows, detached from the store.
   */
  strategies(taskClass?: TaskClass): readonly EvaluatorStrategy[] {
    const rows = [...this.requireStrategies().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => taskClass === undefined || row.taskClass === taskClass)
    rows.sort((left, right) =>
      left.evaluator.localeCompare(right.evaluator)
      || left.taskClass.localeCompare(right.taskClass))
    return rows
  }

  /**
   * Rank one task class's evaluators by their smoothed corroboration weight,
   * each entry naming the route §28 assigns to the final promotion review — the
   * strongest configured verifier — so the recommendation says which model
   * should re-check what it recommends.
   * @param taskClass - the task class to rank evaluators for.
   * @returns the ranked evaluators, most trustworthy first.
   */
  ranking(taskClass: TaskClass): readonly StrategyRanking[] {
    const rows = [...this.requireStrategies().entries()]
      .map(([, row]) => structuredClone(row))
    const promotionReview = this.ctx.get('evolutionModelRoutes')?.recommend('promotion-review') ?? null
    return rankStrategies(rows, taskClass).map(entry => ({ ...entry, promotionReview }))
  }

  /**
   * The evaluator to trust for one task class: the best-ranked evaluator with
   * at least `minimumSamples` independent samples, or undefined while no
   * evaluator has that much independent evidence. The entry names the route
   * §28 puts on the final promotion review, so the caller knows which model
   * should check the verdict before it is acted on. Naming it routes nothing:
   * no run is started from a recommendation (§58.12).
   * @param taskClass - the task class to recommend for.
   * @returns the recommended evaluator, or undefined.
   */
  recommend(taskClass: TaskClass): StrategyRanking | undefined {
    return recommendStrategy([...this.ranking(taskClass)], this.resolved.minimumSamples)
  }

  private requireStrategies(): KvTable<string, EvaluatorStrategy> {
    if (this.strategyTable === undefined) throw new Error('evolution evaluator strategy store is not started yet')
    return this.strategyTable
  }
}

export default EvolutionEvaluatorStrategy
