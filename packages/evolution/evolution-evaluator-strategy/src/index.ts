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
import z from 'zod'
import { evaluatorStrategyDomainSpec } from './spec.ts'
import { rankStrategies, recommendStrategy, strategyKey, updatedStrategy } from './strategy.ts'
import type { EvaluatorOutcome, EvaluatorStrategy, StrategyRanking, TaskClass } from './types.ts'

export type * from './types.ts'
export { rankStrategies, recommendStrategy, strategyKey, updatedStrategy, weightOf } from './strategy.ts'
export { evaluatorStrategyDomainSpec, evaluatorStrategyRow } from './spec.ts'

/** Validated configuration of the evaluator-strategy store. */
export interface EvaluatorStrategyConfig {
  /** Independent samples an evaluator needs before it may be recommended. */
  minimumSamples: number
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

  /** Deployment choice of the evaluator-strategy store. */
  readonly config: EvaluatorStrategyConfig

  private strategyTable?: KvTable<string, EvaluatorStrategy>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated recommendation choices.
   */
  constructor(ctx: Context, config: EvaluatorStrategyConfig) {
    super(ctx, 'evolutionEvaluatorStrategy')
    this.config = config
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
   * Rank one task class's evaluators by their smoothed corroboration weight.
   * @param taskClass - the task class to rank evaluators for.
   * @returns the ranked evaluators, most trustworthy first.
   */
  ranking(taskClass: TaskClass): readonly StrategyRanking[] {
    const rows = [...this.requireStrategies().entries()]
      .map(([, row]) => structuredClone(row))
    return rankStrategies(rows, taskClass)
  }

  /**
   * The evaluator to trust for one task class: the best-ranked evaluator with
   * at least `minimumSamples` independent samples, or undefined while no
   * evaluator has that much independent evidence.
   * @param taskClass - the task class to recommend for.
   * @returns the recommended evaluator, or undefined.
   */
  recommend(taskClass: TaskClass): StrategyRanking | undefined {
    return recommendStrategy([...this.ranking(taskClass)], this.config.minimumSamples)
  }

  private requireStrategies(): KvTable<string, EvaluatorStrategy> {
    if (this.strategyTable === undefined) throw new Error('evolution evaluator strategy store is not started yet')
    return this.strategyTable
  }
}

export default EvolutionEvaluatorStrategy