/**
 * The evolution-budget domain declaration: durable budget allocations and the
 * spend records settled against them. Zod validates the shipped format at the
 * durability boundary.
 * @module @deepseek-ai/dsh-evolution-budget/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BudgetAllocation, SpendRecord } from './types.ts'

/** Durable shape of one budget allocation. */
export const budgetAllocationRow = z.object({
  batchId: z.string(),
  taskClass: z.string(),
  candidateClass: z.enum(['high-potential', 'standard', 'novel', 'low-potential']),
  maxTokens: z.number(),
  maxWallTimeMs: z.number(),
  reason: z.string(),
  at: z.string(),
})

/** Durable shape of one spend record. */
export const spendRecordRow = z.object({
  batchId: z.string(),
  tokens: z.number(),
  wallTimeMs: z.number(),
  rollouts: z.number(),
  at: z.string(),
})

/** One stored allocation, inferred from {@link budgetAllocationRow}. */
export type BudgetAllocationRow = z.infer<typeof budgetAllocationRow>

/** One stored spend record, inferred from {@link spendRecordRow}. */
export type SpendRecordRow = z.infer<typeof spendRecordRow>

/**
 * The evolution-budget domain spec: an `allocations` table keyed by batch
 * identity and a `spends` table keyed by batch identity plus a per-record
 * key. `per-record` because allocations and spends are independent. Invalid
 * rows fail the domain open loudly: settlements trust the numbers they read.
 */
export const budgetDomainSpec = defineDomain({
  name: 'evolution_budget',
  version: 1,
  layout: 'per-record',
  tables: {
    allocations: domainTable<string, BudgetAllocation>(budgetAllocationRow),
    spends: domainTable<string, SpendRecord>(spendRecordRow),
  },
})