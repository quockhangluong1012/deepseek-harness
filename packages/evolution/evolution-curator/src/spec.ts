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

/** One stored debt row, inferred from {@link regressionDebtRecord}. */
export type RegressionDebtRow = z.infer<typeof regressionDebtRecord>

/**
 * The evolution-curator domain spec: one `meta` table holding a single
 * `state` row, plus one `debt` table keyed by skill and failure merge key.
 * Invalid bookkeeping fails the domain open loudly: a lost `lastRunAt`
 * would rerun the first-run deferral and shift the schedule.
 */
export const curatorDomainSpec = defineDomain({
  name: 'evolution_curator',
  version: 2,
  // Version 1 held only the `meta` table; the debt table arrives empty on
  // first write, so vouched-for v1 documents open unchanged.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    meta: domainTable<string, CuratorStateRow>(curatorState),
    debt: domainTable<string, RegressionDebt>(regressionDebtRecord),
  },
})
