/**
 * The evolution-budget domain declaration: durable budget allocations, the
 * spend records settled against them, and the candidate pools the §38
 * screening schedule is derived from. Zod validates the shipped format at the
 * durability boundary.
 * @module @deepseek-ai/dsh-evolution-budget/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BudgetAllocation, PooledCandidate, SpendRecord } from './types.ts'

/**
 * Durable shape of one budget allocation. The §37 cost, deadline, and
 * parallelism ceilings are optional rather than defaulted: a record written
 * before them carries no ceiling of that dimension, and a default would
 * materialize a ceiling nothing priced.
 */
export const budgetAllocationRow = z.object({
  batchId: z.string(),
  taskClass: z.string(),
  candidateClass: z.enum(['high-potential', 'standard', 'novel', 'low-potential']),
  maxTokens: z.number(),
  maxWallTimeMs: z.number(),
  maxCost: z.number().optional(),
  timeLimitMs: z.number().optional(),
  parallelism: z.number().optional(),
  reason: z.string(),
  at: z.string(),
})

/**
 * Durable shape of one spend record. The cost, concurrency, and background
 * compute dimensions are optional for the same reason as the allocation's:
 * an unrecorded measurement is not a zero.
 */
export const spendRecordRow = z.object({
  batchId: z.string(),
  tokens: z.number(),
  wallTimeMs: z.number(),
  rollouts: z.number(),
  cost: z.number().optional(),
  parallelism: z.number().optional(),
  backgroundTokens: z.number().optional(),
  at: z.string(),
})

/** Durable shape of one pooled candidate. */
export const pooledCandidateRow = z.object({
  batchId: z.string(),
  candidateId: z.string(),
  taskClass: z.string(),
  runs: z.number(),
  passes: z.number(),
  novelty: z.number(),
  at: z.string(),
})

/** One stored allocation, inferred from {@link budgetAllocationRow}. */
export type BudgetAllocationRow = z.infer<typeof budgetAllocationRow>

/** One stored spend record, inferred from {@link spendRecordRow}. */
export type SpendRecordRow = z.infer<typeof spendRecordRow>

/** One stored pooled candidate, inferred from {@link pooledCandidateRow}. */
export type PooledCandidateRow = z.infer<typeof pooledCandidateRow>

/**
 * The evolution-budget domain spec: an `allocations` table keyed by batch
 * identity, a `spends` table keyed by batch identity plus a per-record key,
 * and a `pools` table keyed by batch identity plus candidate identity.
 * `per-record` because allocations, spends, and pooled candidates are
 * independent. Invalid rows fail the domain open loudly: settlements and the
 * screening schedule trust the numbers they read.
 */
export const budgetDomainSpec = defineDomain({
  name: 'evolution_budget',
  version: 1,
  layout: 'per-record',
  tables: {
    allocations: domainTable<string, BudgetAllocation>(budgetAllocationRow),
    spends: domainTable<string, SpendRecord>(spendRecordRow),
    pools: domainTable<string, PooledCandidate>(pooledCandidateRow),
  },
})
