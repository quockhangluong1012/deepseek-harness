/**
 * The evolution-benchmark domain declaration: durable evaluation tasks with
 * their contamination states. Zod validates the shipped format at the
 * durability boundary.
 * @module @deepseek-ai/dsh-evolution-benchmark/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BenchmarkTask } from './types.ts'

/** Durable shape of one benchmark task. */
export const benchmarkTaskRow = z.object({
  id: z.string(),
  hash: z.string(),
  capability: z.string(),
  task: z.string(),
  gists: z.array(z.string()),
  sourceSessions: z.array(z.string()),
  at: z.string(),
  state: z.enum(['fresh', 'search', 'validation', 'holdout', 'contaminated', 'retired']),
})

/** One stored task, inferred from {@link benchmarkTaskRow}. */
export type BenchmarkTaskRow = z.infer<typeof benchmarkTaskRow>

/**
 * The evolution-benchmark domain spec: one `tasks` table keyed by task
 * identity. `per-record` because tasks are independent. Invalid rows fail the
 * domain open loudly: benchmark tasks back evaluation decisions, not
 * disposable derived data.
 */
export const benchmarkDomainSpec = defineDomain({
  name: 'evolution_benchmark',
  version: 1,
  layout: 'per-record',
  tables: {
    tasks: domainTable<string, BenchmarkTask>(benchmarkTaskRow),
  },
})
