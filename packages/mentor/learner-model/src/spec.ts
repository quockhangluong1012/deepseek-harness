/**
 * The learner-model domain declaration: the record schema of one learner, the
 * durable field forms of its identities, and the `defineDomain` spec the store
 * opens. Zod validates the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-learner-model/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CaseReference, ConceptId, LearnerId, LearnerRecord } from './types.ts'

/**
 * Durable form of a learner id: a plain string on the medium, branded on read.
 * Exported so a case store keys its records by the same identity instead of
 * declaring a second one.
 */
export const learnerIdSchema = z.string().transform(value => brandString<LearnerId>(value))

/** Durable form of one concept id. */
export const conceptIdSchema = z.string().transform(value => brandString<ConceptId>(value))

/** Durable form of one case reference. */
export const caseReferenceSchema = z.string().transform(value => brandString<CaseReference>(value))

/** How far content may be trusted, at the durable boundary (RUNTIME-SPEC S11). */
export const trustLabelSchema = z.enum(['trusted', 'untrusted', 'unknown'])

/** One recorded familiarity at the durable boundary. */
export const conceptKnowledge = z.object({
  conceptId: conceptIdSchema,
  familiarity: z.number().min(0).max(1),
  observations: z.number().int().min(0),
  lastObservedAt: z.string(),
  trust: trustLabelSchema,
})

/** One recorded application ability at the durable boundary. */
export const applicationAbility = z.object({
  conceptId: conceptIdSchema,
  attempts: z.number().int().min(0),
  successes: z.number().int().min(0),
  lastAppliedAt: z.string(),
  trust: trustLabelSchema,
})

/** One detected misconception at the durable boundary. */
export const misconception = z.object({
  misconceptionId: z.string(),
  statement: z.string(),
  status: z.enum(['detected', 'addressed', 'resolved']),
  recurrences: z.number().int().min(1),
  detectedAt: z.string(),
  updatedAt: z.string(),
  caseIds: z.array(caseReferenceSchema),
  trust: trustLabelSchema,
})

/** One recurring mistake at the durable boundary. */
export const recurringMistake = z.object({
  mistakeId: z.string(),
  statement: z.string(),
  occurrences: z.number().int().min(1),
  conceptIds: z.array(conceptIdSchema),
  firstAt: z.string(),
  lastAt: z.string(),
  caseIds: z.array(caseReferenceSchema),
  trust: trustLabelSchema,
})

/** One stated confidence reading at the durable boundary. */
export const confidenceReading = z.object({
  conceptId: conceptIdSchema,
  stated: z.number().min(0).max(1),
  at: z.string(),
  trust: trustLabelSchema,
})

/** One case impact at the durable boundary. */
export const caseImpact = z.object({
  conceptId: conceptIdSchema,
  impact: z.enum(['strengthened', 'weakened', 'unchanged']),
  at: z.string(),
  trust: trustLabelSchema,
})

/** One case-history entry at the durable boundary. */
export const caseHistoryEntry = z.object({
  caseId: caseReferenceSchema,
  symbol: z.string(),
  reviewedAt: z.string(),
  outcome: z.string().nullable(),
  conceptsTested: z.array(conceptIdSchema),
  lessons: z.array(z.string()),
  mistakes: z.array(z.string()),
  impacts: z.array(caseImpact),
  trust: trustLabelSchema,
})

/** One learning objective at the durable boundary. */
export const learningObjective = z.object({
  objectiveId: z.string(),
  statement: z.string(),
  concepts: z.array(conceptIdSchema),
  raisedAt: z.string(),
  trust: trustLabelSchema,
})

/**
 * Durable shape of one learner record. Compatible additions carry a default or
 * an optional field, so a record written before them parses unchanged.
 */
export const learnerRecord = z.object({
  learnerId: learnerIdSchema,
  updatedAt: z.string().nullable(),
  conceptKnowledge: z.array(conceptKnowledge),
  applicationAbility: z.array(applicationAbility),
  misconceptions: z.array(misconception),
  recurringMistakes: z.array(recurringMistake),
  confidence: z.array(confidenceReading),
  caseHistory: z.array(caseHistoryEntry),
  objectives: z.array(learningObjective),
})

/** One stored learner record, inferred from {@link learnerRecord}. */
export type LearnerRecordRow = z.infer<typeof learnerRecord>

/**
 * The learner-model domain spec: one `learners` table keyed by learner id.
 * `per-record` because each learner's state is independent and disposable on
 * its own, and an unaccepted record document is discarded rather than
 * migrated. Invalid records fail the open loudly: the mentor loop acts on
 * what they say.
 */
export const learnerModelDomainSpec = defineDomain({
  name: 'learner_model',
  version: 1,
  layout: 'per-record',
  tables: { learners: domainTable<LearnerId, LearnerRecord>(learnerRecord) },
})
