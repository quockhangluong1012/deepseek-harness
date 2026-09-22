/**
 * The evolution-retrieval domain declaration: durable recorded session
 * attributions. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-retrieval/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RetrievalAttribution } from './types.ts'

/** Durable shape of one retrieval configuration. */
export const retrievalConfigurationRow = z.object({
  source: z.enum(['vector', 'graph', 'hybrid']),
  queryExpansion: z.enum(['none', 'graph-entities', 'synonyms']),
  weights: z.object({ vector: z.number(), graph: z.number() }),
  reranker: z.enum(['none', 'cross-encoder']),
  mmr: z.object({ enabled: z.boolean(), lambda: z.number() }),
  memoryScope: z.enum(['session', 'workspace', 'global']),
  graphDepth: z.number(),
  threshold: z.number(),
})

/** One stored configuration, inferred from {@link retrievalConfigurationRow}. */
export type RetrievalConfigurationRow = z.infer<typeof retrievalConfigurationRow>

/** Durable shape of one recorded attribution. */
export const retrievalAttributionRow = z.object({
  configKey: z.string(),
  configuration: retrievalConfigurationRow,
  sessionId: z.string(),
  at: z.string(),
})

/** One stored attribution, inferred from {@link retrievalAttributionRow}. */
export type RetrievalAttributionRow = z.infer<typeof retrievalAttributionRow>

/**
 * The evolution-retrieval domain spec: an `attributions` table keyed by the
 * configuration and session joined. `per-record` because attributions are
 * independent; effectiveness derives from them at read time. Invalid rows fail
 * the domain open loudly: the recommendation trusts the numbers it reads.
 */
export const retrievalDomainSpec = defineDomain({
  name: 'evolution_retrieval',
  version: 1,
  layout: 'per-record',
  tables: {
    attributions: domainTable<string, RetrievalAttribution>(retrievalAttributionRow),
  },
})
