/**
 * The ICT case-store domain declaration: the durable artifact schema, the
 * record envelope around it, and the `defineDomain` spec the store opens. The
 * artifact is a strict object, so a stored case carrying a field outside §21's
 * thirteen is rejected at the durability boundary rather than silently
 * truncated. Identities and the trust vocabulary the mentor plane already owns
 * are reused from `dsh-learner-model` instead of being declared twice.
 * @module @deepseek-ai/dsh-case-store/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EvidenceId } from '@deepseek-ai/dsh-agent-kernel'
import { conceptIdSchema, learnerIdSchema, trustLabelSchema } from '@deepseek-ai/dsh-learner-model'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  CaseArtifact, CaseEvidence, CaseFinding, CaseInterpretation, CaseLearnerImpact, CaseObservation, CaseOutcome,
  CaseRecord, CaseThesis, EvidenceKey, CaseId, ImpactId, InterpretationId, ObservationId, ThesisId, FindingId,
  InterpretationKind,
} from './types.ts'

/** Durable form of a case id. */
export const caseIdSchema = z.string().transform(value => brandString<CaseId>(value))

/** Durable form of one evidence key. */
export const evidenceKeySchema = z.string().transform(value => brandString<EvidenceKey>(value))

/** Durable form of one observation id. */
export const observationIdSchema = z.string().transform(value => brandString<ObservationId>(value))

/** Durable form of one interpretation id. */
export const interpretationIdSchema = z.string().transform(value => brandString<InterpretationId>(value))

/** Durable form of one thesis id. */
export const thesisIdSchema = z.string().transform(value => brandString<ThesisId>(value))

/** Durable form of one finding id. */
export const findingIdSchema = z.string().transform(value => brandString<FindingId>(value))

/** Durable form of one impact id. */
export const impactIdSchema = z.string().transform(value => brandString<ImpactId>(value))

/** Durable form of a kernel evidence id: the reference, never the observed content. */
export const evidenceIdSchema = z.string().transform(value => brandString<EvidenceId>(value))

/** One evidence item at the durable boundary. */
export const caseEvidence = z.discriminatedUnion('kind', [
  z.strictObject({
    evidenceKey: evidenceKeySchema,
    kind: z.literal('kernel'),
    evidenceId: evidenceIdSchema,
  }),
  z.strictObject({
    evidenceKey: evidenceKeySchema,
    kind: z.literal('external'),
    locator: z.string(),
    trust: trustLabelSchema,
  }),
]) satisfies z.ZodType<CaseEvidence>

/** One observation at the durable boundary. */
export const caseObservation = z.strictObject({
  observationId: observationIdSchema,
  statement: z.string(),
  timeframe: z.string(),
  barRange: z.string().optional(),
  evidence: z.array(evidenceKeySchema),
  trust: trustLabelSchema,
  observedAt: z.string(),
}) satisfies z.ZodType<CaseObservation>

/**
 * Build the durable schema of one interpretation field. The literal kind is
 * what keeps `agentAudit`, `devilAdvocate`, and `alternativeScenarios` from
 * drifting apart: an entry written into the wrong field is refused here.
 */
function interpretationSchema<K extends InterpretationKind>(kind: K) {
  return z.strictObject({
    interpretationId: interpretationIdSchema,
    kind: z.literal(kind),
    statement: z.string(),
    basis: z.array(observationIdSchema),
    trust: trustLabelSchema,
    at: z.string(),
  }) satisfies z.ZodType<CaseInterpretation<K>>
}

/** One learner statement at the durable boundary. */
export const caseThesis = z.strictObject({
  thesisId: thesisIdSchema,
  statement: z.string(),
  at: z.string(),
  trust: trustLabelSchema,
}) satisfies z.ZodType<CaseThesis>

/** One finding at the durable boundary. */
export const caseFinding = z.strictObject({
  findingId: findingIdSchema,
  statement: z.string(),
  basis: z.array(observationIdSchema),
  concepts: z.array(conceptIdSchema),
  trust: trustLabelSchema,
  at: z.string(),
}) satisfies z.ZodType<CaseFinding>

/** One learner-impact judgement at the durable boundary. */
export const caseLearnerImpact = z.strictObject({
  impactId: impactIdSchema,
  conceptId: conceptIdSchema,
  impact: z.enum(['strengthened', 'weakened', 'unchanged']),
  at: z.string(),
  trust: trustLabelSchema,
}) satisfies z.ZodType<CaseLearnerImpact>

/** The outcome at the durable boundary. */
export const caseOutcome = z.strictObject({
  statement: z.string(),
  at: z.string(),
  trust: trustLabelSchema,
}) satisfies z.ZodType<CaseOutcome>

/**
 * The nullability of `outcome` is the spec's: an unresolved case carries null
 * rather than a placeholder outcome.
 */
export const caseArtifact: z.ZodType<CaseArtifact> = z.strictObject({
  symbol: z.string(),
  timeframes: z.array(z.string()),
  observations: z.array(caseObservation),
  userThesis: z.array(caseThesis),
  evidence: z.array(caseEvidence),
  agentAudit: z.array(interpretationSchema('audit')),
  devilAdvocate: z.array(interpretationSchema('devil-advocate')),
  alternativeScenarios: z.array(interpretationSchema('scenario')),
  outcome: caseOutcome.nullable(),
  mistakes: z.array(caseFinding),
  lessons: z.array(caseFinding),
  conceptsTested: z.array(conceptIdSchema),
  learnerImpact: z.array(caseLearnerImpact),
})

/**
 * Durable shape of one case: the artifact plus the scope, identity, and
 * instants the store owns. Compatible additions carry a default or an optional
 * field, so a record written before them parses unchanged.
 */
export const caseRecord: z.ZodType<CaseRecord> = z.object({
  caseId: caseIdSchema,
  learnerId: learnerIdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  artifact: caseArtifact,
})

/** One stored case record, inferred from {@link caseRecord}. */
export type CaseRecordRow = z.infer<typeof caseRecord>

/**
 * The case-store domain spec: one `cases` table keyed by the learner-scoped
 * composite key. `per-record` because each case is an independent document a
 * reviewer amends on its own, and an unaccepted record document is discarded
 * rather than migrated. Invalid records fail the open loudly: every read path
 * feeds a consumer that acts on what it reads.
 */
export const caseStoreDomainSpec = defineDomain({
  name: 'ict_case',
  version: 1,
  layout: 'per-record',
  tables: { cases: domainTable<string, CaseRecord>(caseRecord) },
})
