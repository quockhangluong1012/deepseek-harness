/**
 * The evolution-heartbeat domain declaration: durable per-task bookkeeping.
 * Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-heartbeat/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { HeartbeatBookkeeping } from './types.ts'

/** Durable bookkeeping for one task: last attempt instant and last failure. */
export const heartbeatBookkeeping = z.object({
  lastRunAtMs: z.number(),
  lastError: z.string().nullable(),
})

/** One stored bookkeeping row, inferred from {@link heartbeatBookkeeping}. */
export type HeartbeatBookkeepingRow = z.infer<typeof heartbeatBookkeeping>

/**
 * The evolution-heartbeat domain spec: one `tasks` table keyed by task name.
 * Invalid bookkeeping fails the domain open loudly: a lost `lastRunAt` would
 * rerun the first-attempt seeding and shift every task's schedule.
 */
export const heartbeatDomainSpec = defineDomain({
  name: 'evolution_heartbeat',
  version: 1,
  layout: 'per-record',
  tables: {
    tasks: domainTable<string, HeartbeatBookkeeping>(heartbeatBookkeeping),
  },
})
