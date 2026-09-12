/**
 * The evolution-curator domain declaration: run bookkeeping and the
 * `defineDomain` spec the curator opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-curator/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Durable curator bookkeeping: the last completed or seeded pass instant. */
export const curatorState = z.object({
  lastRunAt: z.string().nullable(),
})

/** One stored bookkeeping row, inferred from {@link curatorState}. */
export type CuratorStateRow = z.infer<typeof curatorState>

/**
 * The evolution-curator domain spec: one `meta` table holding a single
 * `state` row. Invalid bookkeeping fails the domain open loudly: a lost
 * `lastRunAt` would rerun the first-run deferral and shift the schedule.
 */
export const curatorDomainSpec = defineDomain({
  name: 'evolution_curator',
  version: 1,
  layout: 'per-record',
  tables: {
    meta: domainTable<string, CuratorStateRow>(curatorState),
  },
})
