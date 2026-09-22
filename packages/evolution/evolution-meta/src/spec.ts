/**
 * The evolution-meta domain declaration: durable engine runs under their
 * engine configurations and the sequence each performed. Zod validates the
 * shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-meta/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { EngineRun } from './types.ts'

/** Durable shape of one engine configuration choice. */
export const engineConfigRow = z.object({
  operators: z.string(),
  evaluator: z.string(),
  budget: z.string(),
  routing: z.string(),
})

/** Durable shape of one stage the engine ran. */
export const workflowStepRow = z.object({
  component: z.enum(['operators', 'evaluator', 'budget', 'routing']),
  choice: z.string(),
})

/** Durable shape of one engine run. */
export const engineRunRow = z.object({
  runId: z.string(),
  taskClass: z.string(),
  config: engineConfigRow,
  workflow: z.array(workflowStepRow).default([]),
  pass: z.boolean(),
  tokens: z.number(),
  wallTimeMs: z.number(),
  at: z.string(),
})

/** One stored run, inferred from {@link engineRunRow}. */
export type EngineRunRow = z.infer<typeof engineRunRow>

/**
 * The evolution-meta domain spec: a `runs` table keyed by run identity.
 * `per-record` because runs are append-only events; summaries derive from
 * them at read time. Invalid rows fail the domain open loudly: the engine
 * configuration recommendation trusts the numbers it reads.
 */
export const metaDomainSpec = defineDomain({
  name: 'evolution_meta',
  version: 2,
  // Version 1 stored runs without the sequence they performed; the field
  // defaults to an empty workflow, which the summary reports as unrecorded, so
  // vouched-for v1 runs open unchanged.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    runs: domainTable<string, EngineRun>(engineRunRow),
  },
})
