/**
 * Mutation-operator evolution (`ctx.evolutionOperators`): a durable store of
 * per-operator and per-artifact-class mutation statistics (§8) — attempts,
 * acceptance, mean outcome delta, and regression rate — with the
 * exploration-adjusted ranking (§9) that says which operator to try next on
 * an artifact class. The optimizer records every staged write's operator and
 * outcome through the optional recorder seam, and `/operators` reads the
 * statistics and the ranking. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-operators
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { MUTATION_OPERATORS, rankOperators, recommendOperator, statsKey, updatedStats } from './operators.ts'
import { operatorsDomainSpec } from './spec.ts'
import type { ArtifactClass, OperatorOutcome, OperatorRanking, OperatorStats } from './types.ts'

export type * from './types.ts'
export { MUTATION_OPERATORS, rankOperators, recommendOperator, scoreOf, statsKey, updatedStats } from './operators.ts'
export { operatorStatsRow, operatorsDomainSpec } from './spec.ts'

/** Validated configuration of the mutation-operator store. */
export interface OperatorsConfig {
  /** Exploration bonus weight of the ranking (0 to 1). */
  exploration: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-operator mutation statistics with the next-operator ranking. */
    evolutionOperators: EvolutionOperators
  }
}

/**
 * Mutation-operator store over durable statistics rows. Opens the
 * `evolution_operators` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionOperators extends Service {
  static inject = ['storageDomain']

  /** Deployment choice of the ranking's exploration appetite. */
  static Config = z.object({
    exploration: z.number().min(0).max(1).default(0.2),
  })

  /** Deployment choice of the mutation-operator store. */
  readonly config: OperatorsConfig

  private statsTable?: KvTable<string, OperatorStats>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated operator-ranking choices.
   */
  constructor(ctx: Context, config: OperatorsConfig) {
    super(ctx, 'evolutionOperators')
    this.config = config
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(operatorsDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-operators.domainClose')
    this.statsTable = domain.table('stats')
  }

  /**
   * Record one measured outcome of an operator, upserting the operator's
   * statistics for its artifact class. The stored instant is now.
   * @param outcome - the operator used and its accepted/delta outcome.
   * @returns the updated statistics.
   */
  async record(outcome: OperatorOutcome): Promise<OperatorStats> {
    const key = statsKey(outcome.operator, outcome.artifactClass)
    const next = updatedStats(this.statsTable?.get(key), outcome, new Date().toISOString())
    await this.requireStats().put(key, next)
    return structuredClone(next)
  }

  /**
   * List every recorded statistics row, optionally filtered by artifact
   * class, in canonical operator order then artifact-class order.
   * @param artifactClass - optional artifact-class filter.
   * @returns the rows, detached from the store.
   */
  stats(artifactClass?: ArtifactClass): readonly OperatorStats[] {
    const rows = [...this.requireStats().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => artifactClass === undefined || row.artifactClass === artifactClass)
    rows.sort((left, right) =>
      MUTATION_OPERATORS.indexOf(left.operator) - MUTATION_OPERATORS.indexOf(right.operator)
      || left.artifactClass.localeCompare(right.artifactClass))
    return rows
  }

  /**
   * Rank every canonical operator for one artifact class by the
   * exploration-adjusted score. Untried operators enter with their prior
   * score, so the ranking always names a next operator to try.
   * @param artifactClass - the artifact class to rank operators for.
   * @returns the ranked operators, best first.
   */
  ranking(artifactClass: ArtifactClass): readonly OperatorRanking[] {
    const rows = [...this.requireStats().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => row.artifactClass === artifactClass)
    return rankOperators(rows, artifactClass, this.config.exploration)
  }

  /**
   * The best operator to try next on one artifact class: the ranking's top,
   * the canonical first operator when nothing is recorded for the class.
   * @param artifactClass - the artifact class to recommend for.
   * @returns the recommended operator.
   */
  recommend(artifactClass: ArtifactClass): OperatorRanking | undefined {
    return recommendOperator([...this.ranking(artifactClass)])
  }

  private requireStats(): KvTable<string, OperatorStats> {
    if (this.statsTable === undefined) throw new Error('evolution operators store is not started yet')
    return this.statsTable
  }
}

export default EvolutionOperators