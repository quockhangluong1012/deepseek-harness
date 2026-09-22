/**
 * Evolution budget (`ctx.evolutionBudget`): a durable store of per-batch
 * budget allocations and the spend records settled against them (§37), the
 * recorded candidate pools the §38 screening schedule is derived from, and the
 * §27 resource-aware objectives those records answer. The allocation policy
 * decides a candidate's class from its recorded evidence — high-potential
 * candidates get more budget, low-potential candidates an early-stop screen,
 * novel candidates an exploration allowance — and the settlement says how much
 * of each priced ceiling a batch spent or exceeded. The optimizer records each
 * staged write's allocation and spend through the optional recorder seam, the
 * actuator's budget loop gates a task class's work on `withinBudget`, and
 * `/budget` reads batches and spends. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-budget
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { buildAllocation, dimensionCeilings, poolKey, screeningSchedule, settle, withinAllocation } from './budget.ts'
import { objectiveReadings } from './objectives.ts'
import { policyFor } from './policy.ts'
import { budgetDomainSpec } from './spec.ts'
import type {
  AllocationInput,
  BudgetAllocation,
  BudgetSettlement,
  BudgetTaskClass,
  HalvingSchedule,
  ObjectiveReading,
  PoolInput,
  PooledCandidate,
  SpendInput,
  SpendRecord,
} from './types.ts'

export type * from './types.ts'
export {
  buildAllocation,
  CANDIDATE_CLASSES,
  dimensionCeilings,
  halvingRounds,
  multiplierFor,
  poolKey,
  recordedTotal,
  screeningSchedule,
  settle,
  withinAllocation,
} from './budget.ts'
export { EVOLUTION_OBJECTIVES, objectiveReadings } from './objectives.ts'
export { policyFor } from './policy.ts'
export { budgetAllocationRow, budgetDomainSpec, pooledCandidateRow, spendRecordRow } from './spec.ts'

/** Deployment choices of the evolution-budget store; an omitted field takes its default. */
export interface Config {
  /** Base token ceiling of one standard batch; defaults to 20000. */
  baseMaxTokens?: number
  /** Base wall-time ceiling of one standard batch, in milliseconds; defaults to 600000. */
  baseMaxWallTimeMs?: number
  /** Base cost ceiling of one standard batch, in the deployment's cost units; defaults to 10. */
  baseMaxCost?: number
  /** Base deadline of one standard batch, in milliseconds from its allocation; defaults to 86400000. */
  baseTimeLimitMs?: number
  /** Base concurrency ceiling of one standard batch; defaults to 4. */
  baseParallelism?: number
  /** Share of evaluated candidates each screening round keeps (0 to 1); defaults to 0.5. */
  keepFraction?: number
  /** Screening rounds the §38 schedule derives; defaults to 3. */
  screeningRounds?: number
  /** Passes that make a recorded candidate proven high-potential; defaults to 1. */
  provenPasses?: number
  /** Recorded evaluations a zero-pass candidate needs to count as low-potential; defaults to 1. */
  lowPotentialRuns?: number
  /** Novelty that earns an unproven candidate the exploration branch; defaults to 0.5. */
  noveltyThreshold?: number
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  baseMaxTokens: number
  baseMaxWallTimeMs: number
  baseMaxCost: number
  baseTimeLimitMs: number
  baseParallelism: number
  keepFraction: number
  screeningRounds: number
  provenPasses: number
  lowPotentialRuns: number
  noveltyThreshold: number
}

/**
 * Resolve defaults for the optional ceilings and policy bars.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    baseMaxTokens = 20000,
    baseMaxWallTimeMs = 600000,
    baseMaxCost = 10,
    baseTimeLimitMs = 86400000,
    baseParallelism = 4,
    keepFraction = 0.5,
    screeningRounds = 3,
    provenPasses = 1,
    lowPotentialRuns = 1,
    noveltyThreshold = 0.5,
  } = config
  return {
    baseMaxTokens,
    baseMaxWallTimeMs,
    baseMaxCost,
    baseTimeLimitMs,
    baseParallelism,
    keepFraction,
    screeningRounds,
    provenPasses,
    lowPotentialRuns,
    noveltyThreshold,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable budget allocations and spends with settlements. */
    evolutionBudget: EvolutionBudget
  }
}

/**
 * Evolution-budget store over durable allocations, spends, and candidate
 * pools. Opens the `evolution_budget` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionBudget extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the base ceilings and the policy bars. */
  static Config = z.object({
    baseMaxTokens: z.number().int().min(0).default(20000),
    baseMaxWallTimeMs: z.number().int().min(0).default(600000),
    baseMaxCost: z.number().min(0).default(10),
    baseTimeLimitMs: z.number().int().min(0).default(86400000),
    baseParallelism: z.number().int().min(1).default(4),
    keepFraction: z.number().min(0).max(1).default(0.5),
    screeningRounds: z.number().int().min(1).default(3),
    provenPasses: z.number().int().min(1).default(1),
    lowPotentialRuns: z.number().int().min(1).default(1),
    noveltyThreshold: z.number().min(0).max(1).default(0.5),
  })

  private readonly resolved: ResolvedConfig

  private allocationTable?: KvTable<string, BudgetAllocation>
  private spendTable?: KvTable<string, SpendRecord>
  private poolTable?: KvTable<string, PooledCandidate>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - base ceilings and policy bars of the deployment.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionBudget')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(budgetDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-budget.domainClose')
    this.allocationTable = domain.table('allocations')
    this.spendTable = domain.table('spends')
    this.poolTable = domain.table('pools')
  }

  /**
   * Record a budget allocation for one batch, pricing its candidate class
   * against the base ceilings, including §37's cost, deadline, and parallelism
   * dimensions, and upserting by batch identity. The stored instant is now.
   * @param input - the batch, its task class, and its candidate class.
   * @returns the stored allocation.
   */
  async allocate(input: AllocationInput): Promise<BudgetAllocation> {
    return this.price(input, new Date().toISOString())
  }

  /**
   * Record a budget allocation for one candidate a batch's pool already holds,
   * pricing the class the §37 policy decides from its recorded evidence and
   * naming that branch in the allocation's reason.
   * @param batchId - the batch whose pool holds the candidate.
   * @param candidateId - the pooled candidate to price.
   * @returns the stored allocation.
   */
  async allocateForCandidate(batchId: string, candidateId: string): Promise<BudgetAllocation> {
    const pooled = this.requirePools().get(poolKey(batchId, candidateId))
    if (pooled === undefined) {
      throw new Error(`evolution-budget: batch '${batchId}' recorded no pool candidate '${candidateId}'`)
    }
    const decision = policyFor(pooled, this.resolved)
    return this.price({
      batchId,
      taskClass: pooled.taskClass,
      candidateClass: decision.candidateClass,
      policyReason: decision.reason,
    }, new Date().toISOString())
  }

  /**
   * Record one spend of a batch and settle it against the allocation across
   * every recorded spend of the batch. The allocation must exist: a spend
   * without a priced batch is a surprise, not budget use.
   * @param batchId - the batch spending.
   * @param input - the spend to record.
   * @returns the cumulative settlement of the batch.
   */
  async spend(batchId: string, input: SpendInput): Promise<BudgetSettlement> {
    const allocation = this.requireAllocations().get(batchId)
    if (allocation === undefined) {
      throw new Error(`evolution-budget: unknown batch '${batchId}'`)
    }
    const record: SpendRecord = { ...input, batchId, at: new Date().toISOString() }
    await this.requireSpends().put(`${record.batchId}\0${randomUUID()}`, record)
    return settle(structuredClone(allocation), this.spends(batchId))
  }

  /**
   * Record the candidates one batch screens, upserting each by candidate
   * identity so a re-recorded candidate replaces its evidence and leaves its
   * siblings alone. The stored instant is now.
   * @param input - the batch and the candidates entering its pool.
   * @returns the batch's pool, in candidate-id order.
   */
  async recordPool(input: PoolInput): Promise<readonly PooledCandidate[]> {
    const at = new Date().toISOString()
    for (const candidate of input.candidates) {
      const row: PooledCandidate = { ...candidate, batchId: input.batchId, taskClass: input.taskClass, at }
      await this.requirePools().put(poolKey(input.batchId, candidate.candidateId), row)
    }
    return this.pool(input.batchId)
  }

  /**
   * List a batch's recorded candidate pool in candidate-id order.
   * @param batchId - the batch whose pool to list.
   * @returns the pool, detached from the store.
   */
  pool(batchId: string): readonly PooledCandidate[] {
    const rows = [...this.requirePools().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => row.batchId === batchId)
    rows.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    return rows
  }

  /**
   * The successive-halving screening schedule the batch's recorded pool
   * implies (§38): how many candidates each round evaluates and keeps.
   * @param batchId - the batch whose schedule to derive.
   * @returns the schedule, or undefined when the batch recorded no pool.
   */
  schedule(batchId: string): HalvingSchedule | undefined {
    const pool = this.pool(batchId)
    if (pool.length === 0) return undefined
    return screeningSchedule(pool, this.resolved.keepFraction, this.resolved.screeningRounds)
  }

  /**
   * Read every §27 resource-aware objective the batch's records answer.
   * @param batchId - the batch to read.
   * @returns the readings, canonical order.
   */
  objectives(batchId: string): readonly ObjectiveReading[] {
    if (this.requireAllocations().get(batchId) === undefined) {
      throw new Error(`evolution-budget: unknown batch '${batchId}'`)
    }
    return objectiveReadings(this.pool(batchId), this.spends(batchId))
  }

  /**
   * List recorded allocations, optionally filtered by task class, in
   * batch-id order.
   * @param taskClass - optional task-class filter.
   * @returns the allocations, detached from the store.
   */
  batches(taskClass?: BudgetTaskClass): readonly BudgetAllocation[] {
    const rows = [...this.requireAllocations().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => taskClass === undefined || row.taskClass === taskClass)
    rows.sort((left, right) => left.batchId.localeCompare(right.batchId))
    return rows
  }

  /**
   * List spend records, optionally filtered by batch, newest first with
   * record-key ascending tie-break.
   * @param batchId - optional batch filter.
   * @returns the spend records, detached from the store.
   */
  spends(batchId?: string): readonly SpendRecord[] {
    const rows = [...this.requireSpends().entries()]
      .map(([, row]) => structuredClone(row))
      .filter(row => batchId === undefined || row.batchId === batchId)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.batchId.localeCompare(right.batchId))
    return rows
  }

  /**
   * Whether a batch's cumulative recorded spend stays inside its allocation.
   * @param batchId - the batch to check.
   * @returns true when every measured ceiling holds.
   */
  withinBudget(batchId: string): boolean {
    const allocation = this.requireAllocations().get(batchId)
    if (allocation === undefined) return false
    return withinAllocation(structuredClone(allocation), this.spends(batchId))
  }

  /**
   * Price one allocation from the deployment ceilings and store it.
   * @param input - the batch, its task class, its class, and the policy reason when one decided it.
   * @param at - ISO-8601 instant of the allocation.
   * @returns the stored allocation.
   */
  private async price(input: AllocationInput, at: string): Promise<BudgetAllocation> {
    const priced = buildAllocation(input, this.resolved.baseMaxTokens, this.resolved.baseMaxWallTimeMs, at)
    const dimensions = dimensionCeilings(input.candidateClass, this.resolved)
    const clauses = [input.policyReason, priced.reason, dimensions.reason]
      .filter(clause => clause !== undefined)
    const allocation: BudgetAllocation = {
      ...priced,
      maxCost: dimensions.maxCost,
      timeLimitMs: dimensions.timeLimitMs,
      parallelism: dimensions.parallelism,
      reason: clauses.join('; '),
    }
    await this.requireAllocations().put(allocation.batchId, allocation)
    return structuredClone(allocation)
  }

  private requireAllocations(): KvTable<string, BudgetAllocation> {
    if (this.allocationTable === undefined) throw new Error('evolution budget store is not started yet')
    return this.allocationTable
  }

  private requireSpends(): KvTable<string, SpendRecord> {
    if (this.spendTable === undefined) throw new Error('evolution budget store is not started yet')
    return this.spendTable
  }

  private requirePools(): KvTable<string, PooledCandidate> {
    if (this.poolTable === undefined) throw new Error('evolution budget store is not started yet')
    return this.poolTable
  }
}

export default EvolutionBudget
