/**
 * The evolution-curriculum domain declaration: durable proposed training
 * tasks. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-curriculum/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CurriculumProposal } from './types.ts'

/** Durable shape of one curriculum proposal. */
export const curriculumProposalRow = z.object({
  id: z.string(),
  capability: z.string(),
  task: z.string(),
  sourceSessions: z.array(z.string()),
  gists: z.array(z.string()),
  antiPattern: z.string().nullable().default(null),
  candidateTest: z.string().nullable().default(null),
  at: z.string(),
  state: z.enum(['open', 'retired']),
})

/** One stored proposal, inferred from {@link curriculumProposalRow}. */
export type CurriculumProposalRow = z.infer<typeof curriculumProposalRow>

/**
 * The evolution-curriculum domain spec: one `proposals` table keyed by
 * proposal identity. `per-record` because proposals are independent. Invalid
 * rows fail the domain open loudly: proposals back training decisions, not
 * disposable derived data.
 */
export const curriculumDomainSpec = defineDomain({
  name: 'evolution_curriculum',
  version: 2,
  // Version 1 stored proposals without the matched corrective heuristic; the
  // two new fields default to null, so vouched-for v1 proposals open unchanged.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    proposals: domainTable<string, CurriculumProposal>(curriculumProposalRow),
  },
})
