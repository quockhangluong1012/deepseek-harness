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
  profile: z.enum(['coding', 'research', 'mentor', 'ict']).nullable().default(null),
  family: z.enum(['coding', 'research', 'mentor-ict', 'long-horizon', 'loop-recovery']).default('loop-recovery'),
  stepSpan: z.number().int().min(1).nullable().default(null),
  acceptance: z.string().nullable().default(null),
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
  version: 2,
  // Version 1 stored tasks without a profile, family, or stated horizon; every
  // producer of that generation derived its task from a recorded failure, so
  // those rows open as the loop/recovery family with no declared profile.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    tasks: domainTable<string, BenchmarkTask>(benchmarkTaskRow),
  },
})
