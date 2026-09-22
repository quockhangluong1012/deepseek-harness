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

/** Sighting provenance and counts at the durable boundary. */
export const dreamEvidenceSchema = z.object({
  provenance: z.enum(['attributed', 'unattributed']),
  count: z.number(),
  sessions: z.number(),
})

/** One promotion at the durable boundary. */
export const dreamPromotionSchema = z.object({
  id: z.string(),
  statement: z.string(),
  tool: z.string().nullable(),
  score: z.number(),
  signals: dreamSignalsSchema,
  promotedAt: z.string(),
  // A record written before the provenance gate reads as attributed evidence
  // with no counts, which is what the gate required of everything it admitted.
  evidence: dreamEvidenceSchema.default({ provenance: 'attributed', count: 0, sessions: 0 }),
  restatements: z.array(z.string()).default([]),
  supersededBy: z.string().nullable().default(null),
  supersededAt: z.string().nullable().default(null),
})

/** What one promotion pass did at the durable boundary. */
export const dreamLedgerEvidenceSchema = z.object({
  promoted: z.number(),
  merged: z.number(),
  superseded: z.number(),
  pruned: z.number(),
  rollbackOf: z.string().nullable(),
})

/** One promotion-ledger entry at the durable boundary. */
export const dreamLedgerEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: z.enum(['dreaming', 'operator']),
  action: z.enum(['promote', 'rollback']),
  evidence: dreamLedgerEvidenceSchema,
  before: z.array(dreamPromotionSchema),
  after: z.array(dreamPromotionSchema),
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
  // Absent on records written before the ledger existed, which open with an
  // empty one: nothing rollback-able had been promoted under the old shape.
  ledger: z.array(dreamLedgerEntrySchema).default([]),
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
