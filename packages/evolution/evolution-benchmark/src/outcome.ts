/**
 * The evolution-benchmark run domain: one durable row per executed benchmark
 * task, so an outcome is evidence a metric reader can count rather than
 * something a run reports once and forgets. Zod validates the shipped format
 * at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-benchmark/outcome
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BenchmarkOutcome } from './types.ts'

/** Durable shape of one benchmark task outcome. */
export const benchmarkOutcomeRow = z.object({
  id: z.string(),
  at: z.string(),
  taskId: z.string(),
  capability: z.string(),
  family: z.enum(['coding', 'research', 'mentor-ict', 'long-horizon', 'loop-recovery']),
  profile: z.enum(['coding', 'research', 'mentor', 'ict']).nullable().default(null),
  stepSpan: z.number().int().min(1).nullable().default(null),
  tier: z.number().int().min(1).nullable().default(null),
  pass: z.boolean(),
  status: z.enum(['scored', 'failed']),
  reason: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative(),
  tokens: z.number().nonnegative(),
  wallTimeMs: z.number().nonnegative(),
  samples: z.array(z.number().nonnegative()),
  changes: z.array(z.object({
    path: z.string(),
    kind: z.enum(['added', 'removed', 'changed']),
  })),
  steps: z.number().int().nonnegative(),
  verifications: z.number().int().nonnegative(),
  verificationsPassed: z.number().int().nonnegative(),
  tasksClosed: z.number().int().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  failuresAnswered: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().nullable().default(null),
  contextWindow: z.number().int().positive().nullable().default(null),
  trajectory: z.string().nullable().default(null),
  sessionIds: z.array(z.string()),
})

/** One stored outcome, inferred from {@link benchmarkOutcomeRow}. */
export type BenchmarkOutcomeRow = z.infer<typeof benchmarkOutcomeRow>

/**
 * The evolution-benchmark run domain: one `outcomes` table keyed by outcome
 * identity. `per-record` because outcomes are independent. Invalid rows fail
 * the domain open loudly: a benchmark outcome is the record the §13.5 readings
 * and `benchmark-robustness` are computed from, not disposable derived data.
 */
export const benchmarkRunDomainSpec = defineDomain({
  name: 'evolution_benchmark_runs',
  version: 1,
  layout: 'per-record',
  tables: {
    outcomes: domainTable<string, BenchmarkOutcome>(benchmarkOutcomeRow),
  },
})
