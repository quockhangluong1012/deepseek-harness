/**
 * ICT case store (`ctx.caseStore`): the durable §21 case-study artifact per
 * learner. The record is scoped by a stable learner id and never by a session,
 * so a case outlives the session that produced it. `observations` holds what
 * the chart shows and each interpretation cites the observations it reads, so
 * the two never conflate; a kernel evidence reference carries the evidence id
 * alone and never copies the observed content; every entry carries the trust
 * label of the content behind it (RUNTIME-SPEC S11). Four read paths serve the
 * consumers the spec names: the learner model, misconception detection,
 * benchmark datasets, and the next mentor intervention. Nothing here calls a
 * model or renders prompt text.
 * @module @deepseek-ai/dsh-case-store
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LearnerId } from '@deepseek-ai/dsh-learner-model'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { amendCaseArtifact, emptyCaseArtifact } from './artifact.ts'
import { caseRecord, caseStoreDomainSpec } from './spec.ts'
import type {
  BenchmarkDatasetRow, CaseAmendment, CaseId as CaseIdBrand, CaseOpenInput, CaseRecord, EvidenceKey as EvidenceKeyBrand,
  FindingId as FindingIdBrand, ImpactId as ImpactIdBrand, InterpretationId as InterpretationIdBrand,
  LearnerMemoryProjection, MentorInterventionProjection, MisconceptionDetectionProjection,
  ObservationId as ObservationIdBrand, ThesisId as ThesisIdBrand,
} from './types.ts'

export type * from './types.ts'
export { amendCaseArtifact, emptyCaseArtifact } from './artifact.ts'
export {
  caseArtifact, caseEvidence, caseFinding, caseIdSchema, caseLearnerImpact, caseObservation, caseOutcome, caseRecord,
  caseStoreDomainSpec, caseThesis, evidenceIdSchema, evidenceKeySchema, findingIdSchema, impactIdSchema,
  interpretationIdSchema, observationIdSchema, thesisIdSchema,
} from './spec.ts'

/**
 * The case identity type. Declared here beside its factory so one module export
 * carries both meanings, which is what lets a consumer name the type in a type
 * position and the factory in a value position.
 */
export type CaseId = CaseIdBrand

/** The evidence-key type, declared beside its factory. */
export type EvidenceKey = EvidenceKeyBrand

/** The observation-identity type, declared beside its factory. */
export type ObservationId = ObservationIdBrand

/** The interpretation-identity type, declared beside its factory. */
export type InterpretationId = InterpretationIdBrand

/** The thesis-identity type, declared beside its factory. */
export type ThesisId = ThesisIdBrand

/** The finding-identity type, declared beside its factory. */
export type FindingId = FindingIdBrand

/** The impact-identity type, declared beside its factory. */
export type ImpactId = ImpactIdBrand

/**
 * Brand a string as a {@link CaseId}.
 * @param id - raw case id string.
 * @returns the same string, branded at compile time.
 */
export function CaseId(id: string): CaseId {
  return brandString<CaseId>(id)
}

/**
 * Brand a string as an {@link EvidenceKey}.
 * @param id - raw evidence key string.
 * @returns the same string, branded at compile time.
 */
export function EvidenceKey(id: string): EvidenceKey {
  return brandString<EvidenceKey>(id)
}

/**
 * Brand a string as an {@link ObservationId}.
 * @param id - raw observation id string.
 * @returns the same string, branded at compile time.
 */
export function ObservationId(id: string): ObservationId {
  return brandString<ObservationId>(id)
}

/**
 * Brand a string as an {@link InterpretationId}.
 * @param id - raw interpretation id string.
 * @returns the same string, branded at compile time.
 */
export function InterpretationId(id: string): InterpretationId {
  return brandString<InterpretationId>(id)
}

/**
 * Brand a string as a {@link ThesisId}.
 * @param id - raw thesis id string.
 * @returns the same string, branded at compile time.
 */
export function ThesisId(id: string): ThesisId {
  return brandString<ThesisId>(id)
}

/**
 * Brand a string as a {@link FindingId}.
 * @param id - raw finding id string.
 * @returns the same string, branded at compile time.
 */
export function FindingId(id: string): FindingId {
  return brandString<FindingId>(id)
}

/**
 * Brand a string as an {@link ImpactId}.
 * @param id - raw impact id string.
 * @returns the same string, branded at compile time.
 */
export function ImpactId(id: string): ImpactId {
  return brandString<ImpactId>(id)
}

/** Durable key of one learner's case: the scope, a separator, then the case identity. */
function storageKey(learnerId: LearnerId, caseId: CaseId): string {
  return `${learnerId}\0${caseId}`
}

/**
 * Durable case store over the `ict_case` domain: reads by learner scope and
 * amendments that append one review's entries without touching its siblings.
 * Opens the domain at init and closes it through `ctx.effect`.
 */
export class CaseStore extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, CaseRecord>

  /**
   * @param ctx - host context carrying the storage domain.
   */
  constructor(ctx: Context) {
    super(ctx, 'caseStore')
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(caseStoreDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'case-store.domainClose')
    this.table = domain.table('cases')
  }

  /**
   * Open a case for one learner, minting its identity and starting every other
   * artifact field empty.
   * @param learnerId - the learner whose scope holds the case.
   * @param input - the symbol and timeframes the case opens with.
   * @returns the stored record, detached from the store.
   */
  async createCase(learnerId: LearnerId, input: CaseOpenInput): Promise<CaseRecord> {
    const at = new Date().toISOString()
    const caseId = CaseId(randomUUID())
    const record: CaseRecord = {
      caseId,
      learnerId,
      createdAt: at,
      updatedAt: at,
      artifact: emptyCaseArtifact(input),
    }
    const stored = caseRecord.parse(record)
    await this.requireTable().put(storageKey(learnerId, caseId), stored)
    return structuredClone(stored)
  }

  /**
   * Apply one amendment to a case of this learner's scope, appending each
   * named field's entries by identity. A case id outside this learner's scope
   * is unknown here and rejects.
   * @param learnerId - the learner whose scope holds the case.
   * @param caseId - the case to amend.
   * @param amendment - the entries to apply.
   * @returns the amended record, detached from the store.
   */
  async amend(learnerId: LearnerId, caseId: CaseId, amendment: CaseAmendment): Promise<CaseRecord> {
    const at = new Date().toISOString()
    const stored = await this.requireTable().update(storageKey(learnerId, caseId), current => caseRecord.parse({
      ...current,
      updatedAt: at,
      artifact: amendCaseArtifact(current.artifact, amendment),
    }))
    return structuredClone(stored)
  }

  /**
   * Read one case of this learner's scope.
   * @param learnerId - the learner whose scope holds the case.
   * @param caseId - the case to read.
   * @returns the record, or `undefined` when this learner holds no such case.
   */
  get(learnerId: LearnerId, caseId: CaseId): CaseRecord | undefined {
    const stored = this.requireTable().get(storageKey(learnerId, caseId))
    return stored === undefined ? undefined : structuredClone(stored)
  }

  /**
   * Read every case of one learner's scope.
   * @param learnerId - the learner whose cases to read.
   * @returns the records, earliest case first.
   */
  cases(learnerId: LearnerId): readonly CaseRecord[] {
    return this.rows(learnerId)
  }

  /**
   * Read one learner's cases as the learner model consumes them.
   * @param learnerId - the learner whose cases to read.
   * @returns one projection per case, earliest first.
   */
  forLearnerMemory(learnerId: LearnerId): readonly LearnerMemoryProjection[] {
    return this.rows(learnerId).map(record => ({
      caseId: record.caseId,
      symbol: record.artifact.symbol,
      outcome: record.artifact.outcome,
      conceptsTested: record.artifact.conceptsTested,
      mistakes: record.artifact.mistakes,
      lessons: record.artifact.lessons,
      learnerImpact: record.artifact.learnerImpact,
    }))
  }

  /**
   * Read one learner's cases as a misconception detector consumes them: what
   * the learner claimed, what the agent and the devil's advocate answered, and
   * what the review found wrong.
   * @param learnerId - the learner whose cases to read.
   * @returns one projection per case, earliest first.
   */
  forMisconceptionDetection(learnerId: LearnerId): readonly MisconceptionDetectionProjection[] {
    return this.rows(learnerId).map(record => ({
      caseId: record.caseId,
      symbol: record.artifact.symbol,
      userThesis: record.artifact.userThesis,
      agentAudit: record.artifact.agentAudit,
      devilAdvocate: record.artifact.devilAdvocate,
      mistakes: record.artifact.mistakes,
    }))
  }

  /**
   * Read cases as benchmark dataset rows. The whole artifact travels per row,
   * because a dataset built from these cases consumes the structured case
   * rather than a summary of it.
   * @param learnerId - one learner's scope, or omitted for every recorded case.
   * @returns one row per case, learner then case order.
   */
  forBenchmarkDataset(learnerId?: LearnerId): readonly BenchmarkDatasetRow[] {
    return this.rows(learnerId).map(record => ({
      caseId: record.caseId,
      symbol: record.artifact.symbol,
      artifact: record.artifact,
    }))
  }

  /**
   * Read one learner's cases as the next mentor intervention consumes them:
   * what happened, which concepts it exercised, how the learner moved, and
   * what to teach from it.
   * @param learnerId - the learner whose cases to read.
   * @returns one projection per case, earliest first.
   */
  forMentorIntervention(learnerId: LearnerId): readonly MentorInterventionProjection[] {
    return this.rows(learnerId).map(record => ({
      caseId: record.caseId,
      symbol: record.artifact.symbol,
      outcome: record.artifact.outcome,
      conceptsTested: record.artifact.conceptsTested,
      learnerImpact: record.artifact.learnerImpact,
      lessons: record.artifact.lessons,
    }))
  }

  /** Every stored record of one scope, or of every scope, learner then case order. */
  private rows(learnerId?: LearnerId): readonly CaseRecord[] {
    const records = [...this.requireTable().entries()]
      .map(([, record]) => structuredClone(record))
      .filter(record => learnerId === undefined || record.learnerId === learnerId)
    records.sort((left, right) =>
      String(left.learnerId).localeCompare(String(right.learnerId))
      || left.createdAt.localeCompare(right.createdAt)
      || String(left.caseId).localeCompare(String(right.caseId)))
    return records
  }

  private requireTable(): KvTable<string, CaseRecord> {
    if (this.table === undefined) throw new Error('case store is not started yet')
    return this.table
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable per-learner ICT case artifact: the §21 field set, scoped by learner id and never by session. */
    caseStore: CaseStore
  }
}

export default CaseStore
