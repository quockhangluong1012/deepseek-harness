/**
 * Mutation-operator evolution (`ctx.evolutionOperators`): a durable store of
 * per-operator and per-artifact-class mutation statistics (§8) — attempts,
 * acceptance, mean outcome delta, and regression rate — with the
 * exploration-adjusted ranking (§9) that says which operator to try next on
 * an artifact class, and the instruction proposal each operator and class
 * holds with the verdicts recorded for it. The optimizer records every staged
 * write's operator and outcome through the optional recorder seam, and
 * `/operators` reads the statistics and the ranking. The store records and
 * recommends a mutation instruction; it never rewrites an optimizer's own.
 * Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-operators
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { judgedInstruction, proposedInstruction } from './instructions.ts'
import { MUTATION_OPERATORS, rankOperators, recommendOperator, statsKey, updatedStats } from './operators.ts'
import { operatorsDomainSpec } from './spec.ts'
import type {
  ArtifactClass,
  InstructionInput,
  InstructionVerdict,
  MutationOperator,
  OperatorInstruction,
  OperatorOutcome,
  OperatorRanking,
  OperatorStats,
} from './types.ts'

export type * from './types.ts'
export { instructionAdjustment, judgedInstruction, proposedInstruction } from './instructions.ts'
export { MUTATION_OPERATORS, rankOperators, recommendOperator, scoreOf, statsKey, updatedStats } from './operators.ts'
export type { RankOptions } from './operators.ts'
export { operatorInstructionRow, operatorStatsRow, operatorsDomainSpec } from './spec.ts'

/** Deployment choices for the mutation-operator store; an omitted field takes its default. */
export interface Config {
  /** Exploration bonus weight of the ranking (0 to 1), 0.2 by default. */
  exploration?: number
  /** Weight of the instruction-verdict adjustment (0 to 1), 0.2 by default. */
  instructionWeight?: number
}

/** Validated deployment choices with every default applied. */
export interface ResolvedConfig {
  /** Exploration bonus weight of the ranking (0 to 1). */
  exploration: number
  /** Weight of the instruction-verdict adjustment (0 to 1). */
  instructionWeight: number
}

/**
 * Resolve defaults for the optional store fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { exploration = 0.2, instructionWeight = 0.2 } = config
  return { exploration, instructionWeight }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-operator mutation statistics with the next-operator ranking. */
    evolutionOperators: EvolutionOperators
  }
}

/**
 * Mutation-operator store over durable statistics and instruction rows. Opens
 * the `evolution_operators` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionOperators extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the ranking's exploration appetite and instruction weight. */
  static Config = z.object({
    exploration: z.number().min(0).max(1).default(0.2),
    instructionWeight: z.number().min(0).max(1).default(0.2),
  })

  private readonly resolved: ResolvedConfig

  private statsTable?: KvTable<string, OperatorStats>
  private instructionTable?: KvTable<string, OperatorInstruction>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated operator-ranking choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionOperators')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(operatorsDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-operators.domainClose')
    this.statsTable = domain.table('stats')
    this.instructionTable = domain.table('instructions')
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
   * Record the instruction one operator and artifact class should send. The
   * pair holds one instruction at a time: a different text replaces the
   * previous proposal and starts its verdict tally over, while re-proposing
   * the same text keeps the verdicts it earned. The stored instant is now.
   * @param input - the operator, the artifact class, and the proposed instruction.
   * @returns the stored instruction row.
   */
  async recordInstruction(input: InstructionInput): Promise<OperatorInstruction> {
    const key = statsKey(input.operator, input.artifactClass)
    const next = proposedInstruction(this.instructionTable?.get(key), input, new Date().toISOString())
    await this.requireInstructions().put(key, next)
    return structuredClone(next)
  }

  /**
   * Record one verdict on the instruction its operator and artifact class
   * holds. The pair must hold an instruction: a verdict on nothing would be
   * evidence for a proposal that was never made.
   * @param verdict - the verdict and why it landed that way.
   * @returns the updated instruction row.
   */
  async judgeInstruction(verdict: InstructionVerdict): Promise<OperatorInstruction> {
    const key = statsKey(verdict.operator, verdict.artifactClass)
    const current = this.requireInstructions().get(key)
    if (current === undefined) {
      throw new Error(`evolution-operators: no instruction proposed for '${verdict.operator}' on '${verdict.artifactClass}'`)
    }
    const next = judgedInstruction(structuredClone(current), verdict, new Date().toISOString())
    await this.requireInstructions().put(key, next)
    return structuredClone(next)
  }

  /**
   * Read the instruction one operator and artifact class holds.
   * @param operator - the operator whose instruction to read.
   * @param artifactClass - the artifact class whose instruction to read.
   * @returns the row, or undefined when the pair holds no proposal.
   */
  instruction(operator: MutationOperator, artifactClass: ArtifactClass): OperatorInstruction | undefined {
    const row = this.requireInstructions().get(statsKey(operator, artifactClass))
    return row === undefined ? undefined : structuredClone(row)
  }

  /**
   * List recorded instruction proposals, optionally filtered by artifact
   * class, in canonical operator order then artifact-class order.
   * @param artifactClass - optional artifact-class filter.
   * @returns the rows, detached from the store.
   */
  instructions(artifactClass?: ArtifactClass): readonly OperatorInstruction[] {
    const rows = [...this.requireInstructions().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => artifactClass === undefined || row.artifactClass === artifactClass)
    rows.sort((left, right) =>
      MUTATION_OPERATORS.indexOf(left.operator) - MUTATION_OPERATORS.indexOf(right.operator)
      || left.artifactClass.localeCompare(right.artifactClass))
    return rows
  }

  /**
   * The instruction to try next on one artifact class: the one the ranking's
   * top operator holds, undefined while that operator holds no proposal.
   * @param artifactClass - the artifact class to recommend for.
   * @returns the recommended instruction.
   */
  recommendedInstruction(artifactClass: ArtifactClass): OperatorInstruction | undefined {
    const leader = this.recommend(artifactClass)
    /* v8 ignore next -- the ranking always names a next operator, so a class always has a leader. */
    if (leader === undefined) return undefined
    return this.instruction(leader.operator, artifactClass)
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
   * exploration-adjusted score, nudged by the instruction verdicts the class
   * recorded. Untried operators enter with their prior score, so the ranking
   * always names a next operator to try.
   * @param artifactClass - the artifact class to rank operators for.
   * @returns the ranked operators, best first.
   */
  ranking(artifactClass: ArtifactClass): readonly OperatorRanking[] {
    const rows = [...this.requireStats().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => row.artifactClass === artifactClass)
    const instructions = [...this.requireInstructions().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => row.artifactClass === artifactClass)
    return rankOperators(rows, artifactClass, this.resolved.exploration, {
      instructions,
      instructionWeight: this.resolved.instructionWeight,
    })
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

  private requireInstructions(): KvTable<string, OperatorInstruction> {
    if (this.instructionTable === undefined) throw new Error('evolution operators store is not started yet')
    return this.instructionTable
  }
}

export default EvolutionOperators
