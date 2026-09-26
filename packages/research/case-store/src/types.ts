/**
 * ICT case-study artifact vocabulary: the §21 field set, the entries each
 * field holds, and the projections the four consumers read. The spec's field
 * names and order are the schema's own; nothing here adds a field to the
 * artifact.
 * @module @deepseek-ai/dsh-case-store/src/types
 */

import type { EvidenceId, TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ConceptId, ImpactDirection, LearnerId } from '@deepseek-ai/dsh-learner-model'

/** Identity of one recorded case. Cases belong to a learner's scope, not to a session. */
export type CaseId = Branded<'CaseId'>

/** Identity of one evidence item inside a case, cited by the observations read from it. */
export type EvidenceKey = Branded<'CaseEvidenceKey'>

/** Identity of one directly perceived observation. */
export type ObservationId = Branded<'CaseObservationId'>

/** Identity of one interpretation of the observations. */
export type InterpretationId = Branded<'CaseInterpretationId'>

/** Identity of one statement the learner asserted. */
export type ThesisId = Branded<'CaseThesisId'>

/** Identity of one mistake or lesson the review drew. */
export type FindingId = Branded<'CaseFindingId'>

/** Identity of one judgement of how the case moved the learner. */
export type ImpactId = Branded<'CaseImpactId'>

/** Which reading one interpretation is: the agent's audit, the advocate's critique, or an alternative. */
export type InterpretationKind = 'audit' | 'devil-advocate' | 'scenario'

/**
 * One evidence item of the case. A kernel observation is referenced by its
 * evidence id alone — the case never copies the observed content; an
 * observation with no kernel record is located by an external reference and
 * carries the trust label of wherever that reference points.
 */
export type CaseEvidence =
  | { readonly evidenceKey: EvidenceKey; readonly kind: 'kernel'; readonly evidenceId: EvidenceId }
  | { readonly evidenceKey: EvidenceKey; readonly kind: 'external'; readonly locator: string; readonly trust: TrustLabel }

/**
 * One directly perceived fact of the chart, with the timeframe it was read
 * from. An observation states what the chart shows; a reading of it is an
 * interpretation and belongs in `agentAudit`, `devilAdvocate`, or
 * `alternativeScenarios`.
 */
export interface CaseObservation {
  /** Identity of the observation. */
  readonly observationId: ObservationId
  /** What the chart shows. */
  readonly statement: string
  /** Timeframe the observation was read from. */
  readonly timeframe: string
  /** Bar or session range read, when the observation is bounded to one. */
  readonly barRange?: string | undefined
  /** Evidence the observation was read from; empty when it was read without a recorded evidence item. */
  readonly evidence: readonly EvidenceKey[]
  /** How far the evidence behind the observation may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
  /** ISO-8601 instant the observation was made. */
  readonly observedAt: string
}

/**
 * One interpretation of the observations. `kind` names whose reading it is,
 * and the field it is stored in must agree with that kind; `basis` cites the
 * observations it reads, and an empty basis marks an ungrounded reading rather
 * than an observation.
 */
export interface CaseInterpretation<K extends InterpretationKind = InterpretationKind> {
  /** Identity of the interpretation. */
  readonly interpretationId: InterpretationId
  /** Whose reading this is. */
  readonly kind: K
  /** What the reading says. */
  readonly statement: string
  /** Observations this reading is drawn from. */
  readonly basis: readonly ObservationId[]
  /** How far the evidence behind the reading may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
  /** ISO-8601 instant of the reading. */
  readonly at: string
}

/** One statement the learner asserted about the case. */
export interface CaseThesis {
  /** Identity of the statement. */
  readonly thesisId: ThesisId
  /** What the learner asserted. */
  readonly statement: string
  /** ISO-8601 instant of the assertion. */
  readonly at: string
  /** How far the evidence behind the statement may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** One mistake or lesson the review drew from the case. */
export interface CaseFinding {
  /** Identity of the finding. */
  readonly findingId: FindingId
  /** What the review found. */
  readonly statement: string
  /** Observations the finding rests on. */
  readonly basis: readonly ObservationId[]
  /** Concepts the finding bears on. */
  readonly concepts: readonly ConceptId[]
  /** How far the evidence behind the finding may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
  /** ISO-8601 instant of the finding. */
  readonly at: string
}

/** How one concept fared for the learner in this case. */
export interface CaseLearnerImpact {
  /** Identity of the judgement. */
  readonly impactId: ImpactId
  /** The concept judged. */
  readonly conceptId: ConceptId
  /** Which way the case moved it. */
  readonly impact: ImpactDirection
  /** ISO-8601 instant of the judgement. */
  readonly at: string
  /** How far the evidence behind the judgement may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** What happened in the case, in the reviewer's words. */
export interface CaseOutcome {
  /** What the market or the backtest did. */
  readonly statement: string
  /** ISO-8601 instant the outcome was recorded. */
  readonly at: string
  /** How far the evidence behind the outcome may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** The §21 ICT case-study artifact: exactly the thirteen fields the spec lists, no more. */
export interface CaseArtifact {
  /** Instrument the case reviews. */
  readonly symbol: string
  /** Timeframes the case reads, in the order the analysis reads them. */
  readonly timeframes: readonly string[]
  /** Facts read off the chart, separated from every interpretation of them. */
  readonly observations: readonly CaseObservation[]
  /** What the learner asserted. */
  readonly userThesis: readonly CaseThesis[]
  /** References to the evidence the case rests on. */
  readonly evidence: readonly CaseEvidence[]
  /** The agent's audit of the learner's analysis. */
  readonly agentAudit: readonly CaseInterpretation<'audit'>[]
  /** The devil's advocate's critique of the thesis. */
  readonly devilAdvocate: readonly CaseInterpretation<'devil-advocate'>[]
  /** Alternative scenarios the observations admit. */
  readonly alternativeScenarios: readonly CaseInterpretation<'scenario'>[]
  /** What happened, or `null` while the case is unresolved. */
  readonly outcome: CaseOutcome | null
  /** Mistakes the review found. */
  readonly mistakes: readonly CaseFinding[]
  /** Lessons the review drew. */
  readonly lessons: readonly CaseFinding[]
  /** Concepts the case tested. */
  readonly conceptsTested: readonly ConceptId[]
  /** How the case moved the learner per concept. */
  readonly learnerImpact: readonly CaseLearnerImpact[]
}

/**
 * One durable case record: the artifact plus the store's own scope, identity,
 * and instants. The artifact's field set stays exactly §21's; a consumer that
 * wants only the artifact reads `record.artifact`.
 */
export interface CaseRecord {
  /** Identity of the case. */
  readonly caseId: CaseId
  /** The learner whose scope holds the case. */
  readonly learnerId: LearnerId
  /** ISO-8601 instant the case was opened. */
  readonly createdAt: string
  /** ISO-8601 instant of the last amendment. */
  readonly updatedAt: string
  /** The §21 artifact. */
  readonly artifact: CaseArtifact
}

/** Fields a caller supplies when opening a case. */
export interface CaseOpenInput {
  /** Instrument the case reviews. */
  readonly symbol: string
  /** Timeframes the case reads. */
  readonly timeframes: readonly string[]
}

/**
 * One amendment to an open case. Each named field appends its entries,
 * replacing the entry that carries the same identity in place, so a re-applied
 * review updates rather than duplicates. `outcome` replaces a recorded
 * outcome; an amendment cannot clear one.
 */
export interface CaseAmendment {
  /** Observations to append. */
  readonly observations?: readonly CaseObservation[]
  /** Learner statements to append. */
  readonly userThesis?: readonly CaseThesis[]
  /** Evidence references to append. */
  readonly evidence?: readonly CaseEvidence[]
  /** Audit readings to append. */
  readonly agentAudit?: readonly CaseInterpretation<'audit'>[]
  /** Devil's-advocate readings to append. */
  readonly devilAdvocate?: readonly CaseInterpretation<'devil-advocate'>[]
  /** Alternative-scenario readings to append. */
  readonly alternativeScenarios?: readonly CaseInterpretation<'scenario'>[]
  /** The outcome to record. */
  readonly outcome?: CaseOutcome
  /** Mistakes to append. */
  readonly mistakes?: readonly CaseFinding[]
  /** Lessons to append. */
  readonly lessons?: readonly CaseFinding[]
  /** Concepts the case tested, unioned with the recorded ones. */
  readonly conceptsTested?: readonly ConceptId[]
  /** Learner-impact judgements to append. */
  readonly learnerImpact?: readonly CaseLearnerImpact[]
}

/**
 * One case as the learner model consumes it: what the learner record keeps of
 * a reviewed case without copying the case's content.
 */
export interface LearnerMemoryProjection {
  /** The reviewed case. */
  readonly caseId: CaseId
  /** Instrument the case reviewed. */
  readonly symbol: string
  /** What happened, or `null` while unresolved. */
  readonly outcome: CaseOutcome | null
  /** Concepts the case tested. */
  readonly conceptsTested: readonly ConceptId[]
  /** Mistakes the review found. */
  readonly mistakes: readonly CaseFinding[]
  /** Lessons the review drew. */
  readonly lessons: readonly CaseFinding[]
  /** How the case moved the learner per concept. */
  readonly learnerImpact: readonly CaseLearnerImpact[]
}

/**
 * One case as a misconception detector consumes it: what the learner claimed,
 * what challenged the claim, and what the review found wrong.
 */
export interface MisconceptionDetectionProjection {
  /** The case under detection. */
  readonly caseId: CaseId
  /** Instrument the case reviews. */
  readonly symbol: string
  /** What the learner asserted. */
  readonly userThesis: readonly CaseThesis[]
  /** The agent's audit of those assertions. */
  readonly agentAudit: readonly CaseInterpretation<'audit'>[]
  /** The devil's advocate's critique. */
  readonly devilAdvocate: readonly CaseInterpretation<'devil-advocate'>[]
  /** Mistakes the review found. */
  readonly mistakes: readonly CaseFinding[]
}

/** One case as a benchmark dataset row: the identity plus the whole artifact. */
export interface BenchmarkDatasetRow {
  /** The case the row came from. */
  readonly caseId: CaseId
  /** Instrument the case reviews. */
  readonly symbol: string
  /** The §21 artifact as persisted. */
  readonly artifact: CaseArtifact
}

/**
 * One case as the next mentor intervention consumes it: what happened, which
 * concepts it exercised, how the learner moved, and what to teach from it.
 */
export interface MentorInterventionProjection {
  /** The reviewed case. */
  readonly caseId: CaseId
  /** Instrument the case reviewed. */
  readonly symbol: string
  /** What happened, or `null` while unresolved. */
  readonly outcome: CaseOutcome | null
  /** Concepts the case tested. */
  readonly conceptsTested: readonly ConceptId[]
  /** How the case moved the learner per concept. */
  readonly learnerImpact: readonly CaseLearnerImpact[]
  /** Lessons the review drew, in finding order. */
  readonly lessons: readonly CaseFinding[]
}
