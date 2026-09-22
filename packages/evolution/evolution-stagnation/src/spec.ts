/**
 * The evolution-stagnation domain declaration: durable evaluation runs with
 * their measured triple and improvement flag. Zod validates the shipped
 * format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-stagnation/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { StagnationRun } from './types.ts'

/** Durable shape of one evaluation run. */
export const stagnationRunRow = z.object({
  runId: z.string(),
  skill: z.string(),
  generation: z.number(),
  score: z.object({
    pass: z.boolean(),
    tokens: z.number(),
    wallTimeMs: z.number(),
  }),
  improved: z.boolean(),
  at: z.string(),
})

/** One stored run, inferred from {@link stagnationRunRow}. */
export type StagnationRunRow = z.infer<typeof stagnationRunRow>

/**
 * The evolution-stagnation domain spec: one `runs` table keyed by run
 * identity. `per-record` because runs are independent. Invalid rows fail the
 * domain open loudly: the runs drive evolution-strategy decisions.
 */
export const stagnationDomainSpec = defineDomain({
  name: 'evolution_stagnation',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<string, StagnationRun>(stagnationRunRow),
  },
})
