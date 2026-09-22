/**
 * Evolution budget (`ctx.evolutionBudget`): a durable store of per-batch
 * budget allocations and the spend records settled against them (§37), with
 * the successive-halving screening schedule (§38). The allocation policy
 * prices the candidate class — high-potential candidates get twice the base,
 * novel candidates an exploration allowance, low-potential candidates a cheap
 * screen — and the settlement says exactly how much of each ceiling a batch
 * spent or exceeded. The optimizer records each staged write's allocation
 * and spend through the optional recorder seam, and `/budget` reads batches,
 * spends, and the screening schedule. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-budget
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { buildAllocation, settle, withinAllocation } from './budget.ts'
import { budgetDomainSpec } from './spec.ts'
import type { AllocationInput, BudgetAllocation, BudgetSettlement, BudgetTaskClass, SpendInput, SpendRecord } from './types.ts'

export type * from './types.ts'
export { buildAllocation, CANDIDATE_CLASSES, halvingRounds, multiplierFor, settle, withinAllocation } from './budget.ts'
export { budgetAllocationRow, budgetDomainSpec, spendRecordRow } from './spec.ts'

/** Validated configuration of the evolution-budget store. */
export interface BudgetConfig {
  /** Base token ceiling of one standard batch. */
  baseMaxTokens: number
  /** Base wall-time ceiling of one standard batch, in milliseconds. */
  baseMaxWallTimeMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable budget allocations and spends with settlements. */
    evolutionBudget: EvolutionBudget
  }
}

/**
 * Evolution-budget store over durable allocations and spends. Opens the
 * `evolution_budget` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionBudget extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the base ceilings. */
  static Config = z.object({
    baseMaxTokens: z.number().int().min(0).default(20000),
    baseMaxWallTimeMs: z.number().int().min(0).default(600000),
  })

  /** Deployment choices of the evolution-budget store. */
  readonly config: BudgetConfig

  private allocationTable?: KvTable<string, BudgetAllocation>
  private spendTable?: KvTable<string, SpendRecord>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated base ceilings.
   */
  constructor(ctx: Context, config: BudgetConfig) {
    super(ctx, 'evolutionBudget')
    this.config = config
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(budgetDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-budget.domainClose')
    this.allocationTable = domain.table('allocations')
    this.spendTable = domain.table('spends')
  }

  /**
   * Record a budget allocation for one batch, pricing its candidate class
   * against the base ceilings and upserting by batch identity. The stored
   * instant is now.
   * @param input - the batch, its task class, and its candidate class.
   * @returns the stored allocation.
   */
  async allocate(input: AllocationInput): Promise<BudgetAllocation> {
    const allocation = buildAllocation(input, this.config.baseMaxTokens, this.config.baseMaxWallTimeMs, new Date().toISOString())
    await this.requireAllocations().put(allocation.batchId, allocation)
    return structuredClone(allocation)
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
   * @returns true when both ceilings hold.
   */
  withinBudget(batchId: string): boolean {
    const allocation = this.requireAllocations().get(batchId)
    if (allocation === undefined) return false
    return withinAllocation(structuredClone(allocation), this.spends(batchId))
  }

  private requireAllocations(): KvTable<string, BudgetAllocation> {
    if (this.allocationTable === undefined) throw new Error('evolution budget store is not started yet')
    return this.allocationTable
  }

  private requireSpends(): KvTable<string, SpendRecord> {
    if (this.spendTable === undefined) throw new Error('evolution budget store is not started yet')
    return this.spendTable
  }
}

export default EvolutionBudget