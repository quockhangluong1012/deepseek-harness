/**
 * The evolution-dreams domain: durable per-scope consolidation state. Zod
 * validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-dreaming/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DreamsRecord } from './types.ts'

/** Per-dimension contributions at the durable boundary. */
export const dreamSignalsSchema = z.object({
  relevance: z.number(),
  frequency: z.number(),
  queryDiversity: z.number(),
  recency: z.number(),
  integration: z.number(),
  conceptRichness: z.number(),
})

/** One promotion at the durable boundary. */
export const dreamPromotionSchema = z.object({
  id: z.string(),
  statement: z.string(),
  tool: z.string().nullable(),
  score: z.number(),
  signals: dreamSignalsSchema,
  promotedAt: z.string(),
})

/** One theme at the durable boundary. */
export const dreamThemeSchema = z.object({
  key: z.string(),
  candidates: z.number(),
  bestScore: z.number(),
})

/** One narrative at the durable boundary. */
export const dreamNarrativeSchema = z.object({
  at: z.string(),
  scanned: z.number(),
  staged: z.number(),
  themes: z.array(dreamThemeSchema),
  promoted: z.number(),
  pruned: z.number(),
})

/** Durable per-scope dreaming state at the durable boundary. */
export const dreamsRecordSchema = z.object({
  narratives: z.array(dreamNarrativeSchema),
  promotions: z.array(dreamPromotionSchema),
  updatedAt: z.string(),
})

/**
 * The evolution-dreams domain spec: one `records` table keyed by scope. Invalid
 * records fail the domain open loudly, because a dropped promotion would
 * silently re-offer a consolidated candidate to the next cycle.
 */
export const dreamsDomainSpec = defineDomain({
  name: 'evolution_dreams',
  version: 1,
  layout: 'per-record',
  tables: {
    records: domainTable<string, DreamsRecord>(dreamsRecordSchema),
  },
})
