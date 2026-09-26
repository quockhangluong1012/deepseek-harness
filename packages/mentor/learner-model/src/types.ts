/**
 * Learner-model vocabulary: the durable per-learner record, the concept and
 * application axes it keeps apart, and the evidence one write carries. The 2.0
 * evolution spec §12.8 owns the attribute list this module types.
 * @module @deepseek-ai/dsh-learner-model/src/types
 */

import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Stable identity of one learner. The record is keyed by this id and never by
 * a session, so a learner's state survives every session boundary (§27
 * Mentoring).
 */
export type LearnerId = Branded<'LearnerId'>

/**
 * Reference to one case a case store recorded. The learner model brands the
 * reference it keeps, so a learner id can never be passed where a case
 * reference is expected; the mentor loop converts the case store's id with
 * {@link CaseReference}.
 */
export type CaseReference = Branded<'CaseReference'>

/**
 * Identity of one concept in the mentoring plane's vocabulary. This store
 * records concept ids; the catalog that mints them belongs to the caller that
 * teaches them.
 */
export type ConceptId = Branded<'ConceptId'>

/**
 * What the learner has shown about a concept by talking about it. Familiarity
 * is the stated axis: it never stands in for application mastery (§12.8).
 */
export interface ConceptKnowledge {
  /** The concept this entry is about. */
  readonly conceptId: ConceptId
  /** Familiarity the learner has shown, in `[0, 1]`. */
  readonly familiarity: number
  /** Recorded exchanges that established this familiarity. */
  readonly observations: number
  /** ISO-8601 instant of the last recording. */
  readonly lastObservedAt: string
  /** How far the evidence behind this entry may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/**
 * What the learner has shown about a concept by doing it. Mastery is derived
 * from graded applications only; the stored record keeps the counts, not the
 * ratio, so nothing reads a rounded score as an attempt count.
 */
export interface ApplicationAbility {
  /** The concept this entry is about. */
  readonly conceptId: ConceptId
  /** Graded applications recorded for this concept. */
  readonly attempts: number
  /** Applications of those that succeeded. */
  readonly successes: number
  /** ISO-8601 instant of the last graded application. */
  readonly lastAppliedAt: string
  /** How far the evidence behind this entry may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Where one detected misconception stands in the teach-and-reassess loop. */
export type MisconceptionStatus = 'detected' | 'addressed' | 'resolved'

/** One belief the learner held that the mentor identified as wrong. */
export interface Misconception {
  /** Identity of the misconception, stable across its recurrences. */
  readonly misconceptionId: string
  /** The wrong belief, stated in the terms the learner used. */
  readonly statement: string
  /** Where the belief stands after the last recording. */
  readonly status: MisconceptionStatus
  /** Times the belief was detected; the first detection counts as one. */
  readonly recurrences: number
  /** ISO-8601 instant of the first detection. */
  readonly detectedAt: string
  /** ISO-8601 instant of the last recording. */
  readonly updatedAt: string
  /** Cases the belief was detected in, in first-detection order. */
  readonly caseIds: readonly CaseReference[]
  /** How far the evidence behind this entry may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/**
 * One mistake the learner repeats. Distinct from {@link Misconception}: a
 * mistake is a wrong action, a misconception is a wrong belief that can
 * produce it.
 */
export interface RecurringMistake {
  /** Identity of the mistake, stable across its occurrences. */
  readonly mistakeId: string
  /** What the learner does wrong, stated once. */
  readonly statement: string
  /** Times the mistake was recorded; the first recording counts as one. */
  readonly occurrences: number
  /** Concepts the mistake bears on. */
  readonly conceptIds: readonly ConceptId[]
  /** ISO-8601 instant of the first recording. */
  readonly firstAt: string
  /** ISO-8601 instant of the last recording. */
  readonly lastAt: string
  /** Cases the mistake was recorded in, in first-recording order. */
  readonly caseIds: readonly CaseReference[]
  /** How far the evidence behind this entry may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/**
 * What the learner says about their own grasp of a concept. A third,
 * independent reading: it is neither the stated familiarity nor the measured
 * mastery, and the record never folds it into either.
 */
export interface ConfidenceReading {
  /** The concept this reading is about. */
  readonly conceptId: ConceptId
  /** Confidence the learner stated, in `[0, 1]`. */
  readonly stated: number
  /** ISO-8601 instant of the statement. */
  readonly at: string
  /** How far the evidence behind this reading may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Direction one reviewed case moved the learner's ability in a concept. */
export type ImpactDirection = 'strengthened' | 'weakened' | 'unchanged'

/** How one concept fared for the learner in one reviewed case. */
export interface CaseImpact {
  /** The concept the review judged. */
  readonly conceptId: ConceptId
  /** Which way the case moved it. */
  readonly impact: ImpactDirection
  /** ISO-8601 instant of the judgement. */
  readonly at: string
  /** How far the evidence behind this judgement may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** One reviewed case as the learner's history records it. */
export interface CaseHistoryEntry {
  /** The reviewed case, referenced without copying its content. */
  readonly caseId: CaseReference
  /** Instrument the case reviewed. */
  readonly symbol: string
  /** ISO-8601 instant the case was applied to this record. */
  readonly reviewedAt: string
  /** What happened in the case, or `null` while its outcome is unresolved. */
  readonly outcome: string | null
  /** Concepts the case tested. */
  readonly conceptsTested: readonly ConceptId[]
  /** Lessons the review drew from the case. */
  readonly lessons: readonly string[]
  /** Mistakes the review found in the case. */
  readonly mistakes: readonly string[]
  /** How the case moved the learner per concept. */
  readonly impacts: readonly CaseImpact[]
  /** How far the evidence behind this entry may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** One thing the learner should learn next. */
export interface LearningObjective {
  /** Identity of the objective, stable across reassessments. */
  readonly objectiveId: string
  /** What to learn, stated as an observable outcome. */
  readonly statement: string
  /** Concepts the objective targets. */
  readonly concepts: readonly ConceptId[]
  /** ISO-8601 instant the objective was raised. */
  readonly raisedAt: string
  /** How far the evidence behind this objective may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/**
 * The durable learner record. `updatedAt` is `null` exactly while nothing has
 * been recorded for the learner, so an empty record cannot be mistaken for a
 * stale one.
 */
export interface LearnerRecord {
  /** The learner this record belongs to. */
  readonly learnerId: LearnerId
  /** ISO-8601 instant of the last write, or `null` before the first one. */
  readonly updatedAt: string | null
  /** Each concept's stated familiarity. */
  readonly conceptKnowledge: readonly ConceptKnowledge[]
  /** Each concept's measured application ability. */
  readonly applicationAbility: readonly ApplicationAbility[]
  /** Detected misconceptions. */
  readonly misconceptions: readonly Misconception[]
  /** Mistakes the learner repeats. */
  readonly recurringMistakes: readonly RecurringMistake[]
  /** The learner's stated confidence per concept. */
  readonly confidence: readonly ConfidenceReading[]
  /** The learner's reviewed cases, oldest first. */
  readonly caseHistory: readonly CaseHistoryEntry[]
  /** What the learner should learn next. */
  readonly objectives: readonly LearningObjective[]
}

/**
 * Both axes of one concept, always reported side by side and never merged.
 * `concept` answers what the learner said, `application` what the learner did;
 * a caller asking whether the learner can apply the concept reads
 * `application` (with `applicationMastery`) and ignores `concept`.
 */
export interface ConceptAxes {
  /** The concept both axes belong to. */
  readonly conceptId: ConceptId
  /** The stated axis, absent until one familiarity is recorded. */
  readonly concept: ConceptKnowledge | undefined
  /** The applied axis, absent until one application is graded. */
  readonly application: ApplicationAbility | undefined
}

/** Caller-supplied evidence of one familiarity. */
export interface ConceptEvidence {
  /** The concept. */
  readonly conceptId: ConceptId
  /** Familiarity shown, in `[0, 1]`. */
  readonly familiarity: number
  /** Recorded exchanges that established it. */
  readonly observations: number
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Caller-supplied evidence of one graded application. */
export interface ApplicationEvidence {
  /** The concept applied. */
  readonly conceptId: ConceptId
  /** Whether the application succeeded. */
  readonly succeeded: boolean
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Caller-supplied confidence statement. */
export interface ConfidenceEvidence {
  /** The concept the learner spoke about. */
  readonly conceptId: ConceptId
  /** Stated confidence, in `[0, 1]`. */
  readonly stated: number
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Caller-supplied detection of one misconception. */
export interface MisconceptionEvidence {
  /** Identity of the misconception being detected. */
  readonly misconceptionId: string
  /** The wrong belief, stated in the learner's terms. */
  readonly statement: string
  /** The case it was detected in, when a case review found it. */
  readonly caseId?: CaseReference
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Caller-supplied recording of one mistake occurrence. */
export interface MistakeEvidence {
  /** Identity of the mistake being recorded. */
  readonly mistakeId: string
  /** What the learner does wrong. */
  readonly statement: string
  /** Concepts the mistake bears on. */
  readonly conceptIds: readonly ConceptId[]
  /** The case it was recorded in, when a case review found it. */
  readonly caseId?: CaseReference
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Caller-supplied next objective. */
export interface ObjectiveInput {
  /** Identity of the objective. */
  readonly objectiveId: string
  /** What to learn. */
  readonly statement: string
  /** Concepts the objective targets. */
  readonly concepts: readonly ConceptId[]
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}

/** Caller-supplied judgement of how one case moved the learner. */
export interface CaseImpactInput {
  /** The concept the review judged. */
  readonly conceptId: ConceptId
  /** Which way the case moved it. */
  readonly impact: ImpactDirection
}

/**
 * One reviewed case handed to the learner model. The case store owns the case
 * itself; this input carries the reviewed summary so the record never
 * duplicates case content.
 */
export interface CaseReviewInput {
  /** The reviewed case. */
  readonly caseId: CaseReference
  /** Instrument the case reviewed. */
  readonly symbol: string
  /** What happened, or `null` while unresolved. */
  readonly outcome: string | null
  /** Concepts the case tested. */
  readonly conceptsTested: readonly ConceptId[]
  /** Lessons the review drew. */
  readonly lessons: readonly string[]
  /** Mistakes the review found. */
  readonly mistakes: readonly string[]
  /** How the case moved the learner per concept. */
  readonly impacts: readonly CaseImpactInput[]
  /** How far the evidence may be trusted (RUNTIME-SPEC S11). */
  readonly trust: TrustLabel
}
