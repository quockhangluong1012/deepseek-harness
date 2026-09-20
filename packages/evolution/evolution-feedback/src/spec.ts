/**
 * The evolution-feedback domain declaration: durable per-session failure
 * observations. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-feedback/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { FeedbackRecord, ReflectionRecord } from './types.ts'

/** One observed failure at the durable boundary. */
export const feedbackEntry = z.object({
  tool: z.string().nullable(),
  message: z.string(),
  count: z.number(),
  firstAt: z.string(),
  lastAt: z.string(),
})

/** Durable per-session failure observations at the durable boundary. */
export const feedbackRecordSchema = z.object({
  entries: z.array(feedbackEntry),
  updatedAt: z.string(),
})

/** One stored record, inferred from {@link feedbackRecordSchema}. */
export type FeedbackRecordRow = z.infer<typeof feedbackRecordSchema>

/** Durable shape of one stored reflection analysis. */
export const reflectionRecordSchema = z.object({
  rootCause: z.string().nullable(),
  correctedStrategy: z.string().nullable(),
  reusableWhen: z.string().nullable(),
  antiPattern: z.string().nullable(),
  candidateTest: z.string().nullable(),
  updatedAt: z.string(),
})

/**
 * The evolution-feedback domain spec: one `records` table keyed by session id,
 * one `reflections` table keyed by failure merge key. Invalid records fail the
 * domain open loudly: a dropped `count` would silently reorder which failure
 * the learning loop treats as dominant.
 */
export const feedbackDomainSpec = defineDomain({
  name: 'evolution_feedback',
  version: 2,
  // Version 1 stored only per-session records; the reflections table arrives
  // empty on first write, so vouched-for v1 documents open unchanged.
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    records: domainTable<string, FeedbackRecord>(feedbackRecordSchema),
    reflections: domainTable<string, ReflectionRecord>(reflectionRecordSchema),
  },
})
