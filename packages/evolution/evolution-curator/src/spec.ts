/**
 * The evolution-curator domain declaration: run bookkeeping and the
 * `defineDomain` spec the curator opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-curator/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RegressionDebt } from './types.ts'

/** Durable curator bookkeeping: the last completed or seeded pass instant. */
export const curatorState = z.object({
  lastRunAt: z.string().nullable(),
})

/** One stored bookkeeping row, inferred from {@link curatorState}. */
export type CuratorStateRow = z.infer<typeof curatorState>

/** Durable open regression debt: one failure one skill has not answered. */
export const regressionDebtRecord = z.object({
  name: z.string().min(1),
  mergeKey: z.string().min(1),
  message: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  passes: z.number().int().min(1),
  sessions: z.number().int().min(1),
  revision: z.number().int().min(0),
})

/** One consolidation verdict a staged review awaits, or replays into `applyConsolidation`. */
export const pendingConsolidationVerdict = z.object({
  name: z.string().min(1),
  action: z.enum(['keep', 'patch', 'consolidate', 'archive']),
  into: z.string().optional(),
  body: z.string().optional(),
})

/** Durable consolidation cost row, mirroring {@link ConsolidationCost}. */
export const pendingConsolidationCost = z.object({
  inputBytes: z.number().int().min(0),
  maxOutputTokens: z.number().int().min(0),
  provider: z.string().min(1),
  model: z.string().min(1),
  truncated: z.boolean(),
})

/**
 * One consolidation pass staged for review: `requireConsolidationReview`
 * withholds the fork's verdicts from `applyConsolidation` until a reviewer
 * distinct from `proposerIdentity` applies them.
 */
export const pendingConsolidationRecord = z.object({
  passId: z.string().min(1),
  at: z.string(),
  proposerIdentity: z.string().min(1),
  verdicts: z.array(pendingConsolidationVerdict),
  cost: pendingConsolidationCost,
  steps: z.number().int().min(0),
})

/** One stored pending-consolidation row, inferred from {@link pendingConsolidationRecord}. */
export type PendingConsolidationRow = z.infer<typeof pendingConsolidationRecord>

/**
 * The evolution-curator domain spec: one `meta` table holding a single
 * `state` row, one `debt` table keyed by skill and failure merge key, and one
 * `pending` table keyed by pass id holding a consolidation awaiting review.
 * Invalid bookkeeping fails the domain open loudly: a lost `lastRunAt`
 * would rerun the first-run deferral and shift the schedule.
 */
export const curatorDomainSpec = defineDomain({
  name: 'evolution_curator',
  version: 3,
  // Version 1 held only the `meta` table, version 2 added `debt`; both arrive
  // with `pending` empty on first write, the same way `debt` arrived empty
  // for a vouched-for v1 document.
  compatibleVersions: [1, 2],
  layout: 'per-record',
  tables: {
    meta: domainTable<string, CuratorStateRow>(curatorState),
    debt: domainTable<string, RegressionDebt>(regressionDebtRecord),
    pending: domainTable<string, PendingConsolidationRow>(pendingConsolidationRecord),
  },
})
