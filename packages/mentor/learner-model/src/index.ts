/**
 * Learner model (`ctx.learnerModel`): the durable per-learner record §12.8
 * requires — concept knowledge, application ability, misconceptions, recurring
 * mistakes, confidence, case history, and next learning objectives. The record
 * is keyed by a stable learner id, never by a session, so state survives a
 * session boundary (§27 Mentoring). Concept knowledge and application ability
 * are separate axes with separate entry lists: familiarity is what the learner
 * says, mastery is what graded applications measured, and no transform moves
 * one from the other. Every entry carries the trust label of the content it
 * came from (RUNTIME-SPEC S11). Nothing here calls a model or renders prompt
 * text.
 * @module @deepseek-ai/dsh-learner-model
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  conceptAxes, emptyLearnerRecord, recordApplicationAbility, recordCaseReview, recordConceptKnowledge,
  recordConfidenceReading, recordMisconceptionEntry, recordMisconceptionStatus, recordRecurringMistake,
  replaceObjectives,
} from './record.ts'
import { learnerModelDomainSpec, learnerRecord } from './spec.ts'
import type {
  ApplicationEvidence, CaseReference as CaseReferenceBrand, CaseReviewInput, ConceptAxes, ConceptEvidence,
  ConceptId as ConceptIdBrand, ConfidenceEvidence, LearnerId as LearnerIdBrand, LearnerRecord, LearningObjective,
  Misconception, MisconceptionEvidence, MisconceptionStatus, MistakeEvidence, ObjectiveInput, RecurringMistake,
} from './types.ts'

export type * from './types.ts'
export { applicationMastery, conceptAxes, emptyLearnerRecord } from './record.ts'
export {
  applicationAbility, caseHistoryEntry, caseImpact, conceptKnowledge, confidenceReading, conceptIdSchema,
  caseReferenceSchema, learnerIdSchema, learnerModelDomainSpec, learnerRecord, learningObjective, misconception,
  recurringMistake, trustLabelSchema,
} from './spec.ts'

/**
 * The learner identity type. Declared here beside its factory so one module
 * export carries both meanings, which is what lets a consumer name the type in
 * a type position and the factory in a value position.
 */
export type LearnerId = LearnerIdBrand

/** The case-reference type, declared beside its factory. */
export type CaseReference = CaseReferenceBrand

/** The concept-identity type, declared beside its factory. */
export type ConceptId = ConceptIdBrand

/**
 * Brand a string as a {@link LearnerId}.
 * @param id - raw learner id string owned by the deployment.
 * @returns the same string, branded at compile time.
 */
export function LearnerId(id: string): LearnerId {
  return brandString<LearnerId>(id)
}

/**
 * Brand a string as a {@link CaseReference} to a case another store owns.
 * @param id - the case store's case id.
 * @returns the same string, branded as a case reference.
 */
export function CaseReference(id: string): CaseReference {
  return brandString<CaseReference>(id)
}

/**
 * Brand a string as a {@link ConceptId}.
 * @param id - raw concept id owned by the mentoring plane.
 * @returns the same string, branded at compile time.
 */
export function ConceptId(id: string): ConceptId {
  return brandString<ConceptId>(id)
}

/**
 * Durable learner model over the `learner_model` domain: synchronous reads of
 * one learner's record and durable accumulating writes into it. Opens the
 * domain at init and closes it through `ctx.effect`.
 */
export class LearnerModel extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<LearnerId, LearnerRecord>

  /**
   * @param ctx - host context carrying the storage domain.
   */
  constructor(ctx: Context) {
    super(ctx, 'learnerModel')
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(learnerModelDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'learner-model.domainClose')
    this.table = domain.table('learners')
  }

  /**
   * Read one learner's record, detached from the store.
   * @param learnerId - the learner to read.
   * @returns the stored record, or an empty one whose `updatedAt` is `null` when the learner has nothing recorded.
   */
  read(learnerId: LearnerId): LearnerRecord {
    const stored = this.requireTable().get(learnerId)
    return stored === undefined ? emptyLearnerRecord(learnerId) : structuredClone(stored)
  }

  /**
   * Read both knowledge axes of one concept side by side.
   * @param learnerId - the learner to read.
   * @param conceptId - the concept whose axes to read.
   * @returns the two axes, each `undefined` until recorded.
   */
  axes(learnerId: LearnerId, conceptId: ConceptId): ConceptAxes {
    return conceptAxes(this.read(learnerId), conceptId)
  }

  /**
   * Read the learner's detected misconceptions.
   * @param learnerId - the learner to read.
   * @returns the misconceptions, in first-detection order.
   */
  misconceptions(learnerId: LearnerId): readonly Misconception[] {
    return this.read(learnerId).misconceptions
  }

  /**
   * Read the mistakes the learner repeats.
   * @param learnerId - the learner to read.
   * @returns the recurring mistakes, in first-recording order.
   */
  mistakes(learnerId: LearnerId): readonly RecurringMistake[] {
    return this.read(learnerId).recurringMistakes
  }

  /**
   * Read what the learner should learn next.
   * @param learnerId - the learner to read.
   * @returns the objectives the last assessment decided.
   */
  objectives(learnerId: LearnerId): readonly LearningObjective[] {
    return this.read(learnerId).objectives
  }

  /**
   * Record what the learner has shown about a concept by talking about it.
   * This write moves the stated axis only.
   * @param learnerId - the learner to write.
   * @param evidence - the familiarity shown, its exchange count, and its trust label.
   * @returns the updated record, detached from the store.
   */
  recordConcept(learnerId: LearnerId, evidence: ConceptEvidence): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordConceptKnowledge(record, evidence, at))
  }

  /**
   * Record one graded application. This write moves the applied axis only, and
   * it is the only write that can: nothing else in the store raises mastery.
   * @param learnerId - the learner to write.
   * @param evidence - the concept applied, whether it succeeded, and its trust label.
   * @returns the updated record, detached from the store.
   */
  recordApplication(learnerId: LearnerId, evidence: ApplicationEvidence): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordApplicationAbility(record, evidence, at))
  }

  /**
   * Record what the learner says about their own grasp of a concept.
   * @param learnerId - the learner to write.
   * @param evidence - the stated confidence and its trust label.
   * @returns the updated record, detached from the store.
   */
  recordConfidence(learnerId: LearnerId, evidence: ConfidenceEvidence): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordConfidenceReading(record, evidence, at))
  }

  /**
   * Record one detection of a misconception, counting its recurrences.
   * @param learnerId - the learner to write.
   * @param evidence - the detected belief, the case that surfaced it, and its trust label.
   * @returns the updated record, detached from the store.
   */
  recordMisconception(learnerId: LearnerId, evidence: MisconceptionEvidence): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordMisconceptionEntry(record, evidence, at))
  }

  /**
   * Move a known misconception to a new status.
   * @param learnerId - the learner to write.
   * @param misconceptionId - the recorded belief to move.
   * @param status - where the belief now stands.
   * @returns the updated record, detached from the store.
   */
  setMisconceptionStatus(
    learnerId: LearnerId,
    misconceptionId: string,
    status: MisconceptionStatus,
  ): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordMisconceptionStatus(record, misconceptionId, status, at))
  }

  /**
   * Record one occurrence of a mistake the learner repeats.
   * @param learnerId - the learner to write.
   * @param evidence - the mistake, the concepts it bears on, the case that surfaced it, and its trust label.
   * @returns the updated record, detached from the store.
   */
  recordMistake(learnerId: LearnerId, evidence: MistakeEvidence): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordRecurringMistake(record, evidence, at))
  }

  /**
   * Replace the learner's next objectives with what the last assessment decided.
   * @param learnerId - the learner to write.
   * @param objectives - the next objectives; one that survives keeps its original instant.
   * @returns the updated record, detached from the store.
   */
  setObjectives(learnerId: LearnerId, objectives: readonly ObjectiveInput[]): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => replaceObjectives(record, objectives, at))
  }

  /**
   * Record one reviewed case in the learner's history. The case content stays
   * in the case store; this write keeps the review summary and the case
   * reference.
   * @param learnerId - the learner to write.
   * @param review - the reviewed case summary.
   * @returns the updated record, detached from the store.
   */
  applyCase(learnerId: LearnerId, review: CaseReviewInput): Promise<LearnerRecord> {
    return this.mutate(learnerId, (record, at) => recordCaseReview(record, review, at))
  }

  /**
   * Apply one transform and store the result. An existing record is
   * transformed at its write-chain slot, so concurrent writes never interleave;
   * a first write stores the transform of the empty record. Every stored value
   * passes the domain record schema, so a caller-supplied value outside its
   * contract fails here rather than at the next open.
   */
  private async mutate(
    learnerId: LearnerId,
    transform: (record: LearnerRecord, at: string) => LearnerRecord,
  ): Promise<LearnerRecord> {
    const table = this.requireTable()
    const at = new Date().toISOString()
    const current = table.get(learnerId)
    if (current === undefined) {
      const created = learnerRecord.parse(transform(emptyLearnerRecord(learnerId), at))
      await table.put(learnerId, created)
      return structuredClone(created)
    }
    const stored = await table.update(learnerId, value => learnerRecord.parse(transform(value, at)))
    return structuredClone(stored)
  }

  private requireTable(): KvTable<LearnerId, LearnerRecord> {
    if (this.table === undefined) throw new Error('learner model store is not started yet')
    return this.table
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Durable per-learner record owner: concept knowledge, application ability, misconceptions,
     * recurring mistakes, confidence, case history, and next objectives (SPEC-2.0 §12.8).
     */
    learnerModel: LearnerModel
  }
}

export default LearnerModel
