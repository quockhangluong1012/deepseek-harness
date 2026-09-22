/**
 * The evolution-sleeptime domain declaration: durable anticipated future tasks
 * and the precomputed reasoning artifacts cached for them. Zod validates the
 * shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-sleeptime/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AnticipatedTask, PrecomputeArtifact } from './types.ts'

/** Durable shape of one anticipated task. */
export const anticipatedTaskRow = z.object({
  taskId: z.string(),
  domain: z.string(),
  scope: z.string().optional(),
  likelihood: z.number(),
  expectedQueries: z.number(),
  expectedSavingTokens: z.number(),
  at: z.string(),
})

/** Durable shape of one precomputed artifact. */
export const precomputeArtifactRow = z.object({
  artifactId: z.string(),
  taskId: z.string(),
  kind: z.enum(['summary', 'retrieval-index', 'candidate-plan']),
  summary: z.string(),
  offlineCostTokens: z.number(),
  hits: z.number(),
  savedTokens: z.number(),
  at: z.string(),
})

/** One stored task, inferred from {@link anticipatedTaskRow}. */
export type AnticipatedTaskRow = z.infer<typeof anticipatedTaskRow>

/** One stored artifact, inferred from {@link precomputeArtifactRow}. */
export type PrecomputeArtifactRow = z.infer<typeof precomputeArtifactRow>

/**
 * The evolution-sleeptime domain spec: a `tasks` table keyed by task identity
 * and an `artifacts` table keyed by artifact identity. `per-record` because
 * tasks and artifacts are independent. Invalid rows fail the domain open
 * loudly: artifacts steer what idle time precomputes.
 */
export const sleeptimeDomainSpec = defineDomain({
  name: 'evolution_sleeptime',
  version: 1,
  layout: 'per-record',
  tables: {
    tasks: domainTable<string, AnticipatedTask>(anticipatedTaskRow),
    artifacts: domainTable<string, PrecomputeArtifact>(precomputeArtifactRow),
  },
})
