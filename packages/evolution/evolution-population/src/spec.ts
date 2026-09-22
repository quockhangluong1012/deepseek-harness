/**
 * The evolution-population domain declaration: durable population candidates
 * with generation, lineage, and status. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-population/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { PopulationCandidate } from './types.ts'

/** Durable shape of one population candidate. */
export const populationCandidateRow = z.object({
  candidateId: z.string(),
  skill: z.string(),
  parentCandidateId: z.string().nullable(),
  operator: z.string(),
  generation: z.number(),
  novelty: z.number(),
  triple: z
    .object({
      pass: z.boolean(),
      tokens: z.number(),
      wallTimeMs: z.number(),
    })
    .nullable(),
  status: z.enum(['staged', 'approved', 'rejected']),
  at: z.string(),
})

/** One stored candidate, inferred from {@link populationCandidateRow}. */
export type PopulationCandidateRow = z.infer<typeof populationCandidateRow>

/**
 * The evolution-population domain spec: one `candidates` table keyed by
 * candidate identity. `per-record` because candidates are independent.
 * Invalid rows fail the domain open loudly: candidates back evolution
 * decisions, not disposable derived data.
 */
export const populationDomainSpec = defineDomain({
  name: 'evolution_population',
  version: 1,
  layout: 'per-record',
  tables: {
    candidates: domainTable<string, PopulationCandidate>(populationCandidateRow),
  },
})
