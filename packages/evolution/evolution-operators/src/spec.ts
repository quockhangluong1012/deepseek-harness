/**
 * The evolution-operators domain declaration: durable per-operator and
 * per-artifact-class mutation statistics. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-operators/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { OperatorStats } from './types.ts'

/** Durable shape of one operator's statistics. */
export const operatorStatsRow = z.object({
  operator: z.string(),
  artifactClass: z.string(),
  attempts: z.number(),
  accepted: z.number(),
  meanDelta: z.number(),
  regressionRate: z.number(),
  lastAt: z.string(),
})

/** One stored statistics row, inferred from {@link operatorStatsRow}. */
export type OperatorStatsRow = z.infer<typeof operatorStatsRow>

/**
 * The evolution-operators domain spec: a `stats` table keyed by operator and
 * artifact class joined. `per-record` because each operator/class pair is
 * independent. Invalid rows fail the domain open loudly: ranking trusts the
 * numbers it reads.
 */
export const operatorsDomainSpec = defineDomain({
  name: 'evolution_operators',
  version: 1,
  layout: 'per-record',
  tables: {
    stats: domainTable<string, OperatorStats>(operatorStatsRow),
  },
})