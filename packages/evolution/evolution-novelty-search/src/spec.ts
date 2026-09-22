/**
 * The evolution-novelty-search domain declaration: durable archive entries
 * with their behavior descriptor and measured archive novelty. Zod validates
 * the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-novelty-search/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { NoveltyArchiveEntry } from './types.ts'

/** Durable shape of one novelty-archive entry. */
export const noveltyArchiveEntryRow = z.object({
  candidateId: z.string(),
  skill: z.string(),
  features: z.array(z.string()),
  novelty: z.number(),
  at: z.string(),
})

/** One stored archive entry, inferred from {@link noveltyArchiveEntryRow}. */
export type NoveltyArchiveEntryRow = z.infer<typeof noveltyArchiveEntryRow>

/**
 * The evolution-novelty-search domain spec: one `archive` table keyed by
 * staged-write identity. `per-record` because entries are independent.
 * Invalid rows fail the domain open loudly: the archive measures evolution
 * direction, not disposable derived data.
 */
export const noveltyDomainSpec = defineDomain({
  name: 'evolution_novelty',
  version: 1,
  layout: 'per-record',
  tables: {
    archive: domainTable<string, NoveltyArchiveEntry>(noveltyArchiveEntryRow),
  },
})
