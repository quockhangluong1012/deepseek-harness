/**
 * Pure record transforms of the learner model: each takes the record a write
 * read at its chain slot and returns the next record. No I/O and no clock —
 * the caller supplies the ISO-8601 instant, so every transform stays
 * deterministic and testable on its own.
 * @module @deepseek-ai/dsh-learner-model/src/record
 */

import type {
  ApplicationAbility, ApplicationEvidence, CaseHistoryEntry, CaseReference, CaseReviewInput, ConceptAxes,
  ConceptEvidence, ConceptId, ConceptKnowledge, ConfidenceEvidence, ConfidenceReading, LearnerId, LearnerRecord,
  LearningObjective, Misconception, MisconceptionEvidence, MisconceptionStatus, MistakeEvidence, ObjectiveInput,
  RecurringMistake,
} from './types.ts'

/**
 * The record of a learner with nothing recorded yet. `updatedAt` stays `null`
 * so an untouched learner is distinguishable from a stale one.
 * @param learnerId - the learner the record belongs to.
 * @returns the empty record.
 */
export function emptyLearnerRecord(learnerId: LearnerId): LearnerRecord {
  return {
    learnerId,
    updatedAt: null,
    conceptKnowledge: [],
    applicationAbility: [],
    misconceptions: [],
    recurringMistakes: [],
    confidence: [],
    caseHistory: [],
    objectives: [],
  }
}

/**
 * Both axes of one concept, kept apart: what the learner stated and what the
 * learner did, each absent until recorded. A caller asking whether the learner
 * can apply the concept reads `application`, never `concept`.
 * @param record - the learner record to read.
 * @param conceptId - the concept whose axes to read.
 * @returns both axes, either side `undefined` when unrecorded.
 */
export function conceptAxes(record: LearnerRecord, conceptId: ConceptId): ConceptAxes {
  return {
    conceptId,
    concept: record.conceptKnowledge.find(entry => entry.conceptId === conceptId),
    application: record.applicationAbility.find(entry => entry.conceptId === conceptId),
  }
}

/**
 * Ratio of graded applications that succeeded.
 * @param ability - the recorded application ability.
 * @returns the ratio in `[0, 1]`, or `undefined` while no application is graded — an ungraded axis is not a zero.
 */
export function applicationMastery(ability: ApplicationAbility): number | undefined {
  return ability.attempts === 0 ? undefined : ability.successes / ability.attempts
}

/** Replace the entry with the same key, or append it when the key is new. */
function upsert<T>(entries: readonly T[], entry: T, keyOf: (value: T) => string): readonly T[] {
  const index = entries.findIndex(value => keyOf(value) === keyOf(entry))
  if (index < 0) return [...entries, entry]
  const next = [...entries]
  next[index] = entry
  return next
}

/** Append one case reference when it is absent, preserving first-recording order. */
function withCase(ids: readonly CaseReference[], caseId: CaseReference | undefined): readonly CaseReference[] {
  if (caseId === undefined || ids.includes(caseId)) return ids
  return [...ids, caseId]
}

/**
 * Record one familiarity reading, replacing the concept's previous one.
 * @param record - the learner record at its chain slot.
 * @param evidence - the familiarity shown.
 * @param at - ISO-8601 instant of the recording.
 * @returns the next record.
 */
export function recordConceptKnowledge(
  record: LearnerRecord,
  evidence: ConceptEvidence,
  at: string,
): LearnerRecord {
  const entry: ConceptKnowledge = {
    conceptId: evidence.conceptId,
    familiarity: evidence.familiarity,
    observations: evidence.observations,
    lastObservedAt: at,
    trust: evidence.trust,
  }
  return {
    ...record,
    updatedAt: at,
    conceptKnowledge: upsert(record.conceptKnowledge, entry, value => value.conceptId),
  }
}

/**
 * Record one graded application, accumulating the concept's attempt and
 * success counts. This is the only transform that moves the applied axis.
 * @param record - the learner record at its chain slot.
 * @param evidence - the graded application.
 * @param at - ISO-8601 instant of the recording.
 * @returns the next record.
 */
export function recordApplicationAbility(
  record: LearnerRecord,
  evidence: ApplicationEvidence,
  at: string,
): LearnerRecord {
  const current = record.applicationAbility.find(entry => entry.conceptId === evidence.conceptId)
  const entry: ApplicationAbility = {
    conceptId: evidence.conceptId,
    attempts: (current?.attempts ?? 0) + 1,
    successes: (current?.successes ?? 0) + (evidence.succeeded ? 1 : 0),
    lastAppliedAt: at,
    trust: evidence.trust,
  }
  return {
    ...record,
    updatedAt: at,
    applicationAbility: upsert(record.applicationAbility, entry, value => value.conceptId),
  }
}

/**
 * Record what the learner stated about their own grasp, replacing the
 * concept's previous reading.
 * @param record - the learner record at its chain slot.
 * @param evidence - the stated confidence.
 * @param at - ISO-8601 instant of the statement.
 * @returns the next record.
 */
export function recordConfidenceReading(
  record: LearnerRecord,
  evidence: ConfidenceEvidence,
  at: string,
): LearnerRecord {
  const entry: ConfidenceReading = {
    conceptId: evidence.conceptId,
    stated: evidence.stated,
    at,
    trust: evidence.trust,
  }
  return {
    ...record,
    updatedAt: at,
    confidence: upsert(record.confidence, entry, value => value.conceptId),
  }
}

/**
 * Record one detection of a misconception: a new belief starts at one
 * recurrence, a known belief counts up. A belief detected again after being
 * resolved returns to `detected`, because a recurrence is evidence it is live.
 * @param record - the learner record at its chain slot.
 * @param evidence - the detected belief.
 * @param at - ISO-8601 instant of the detection.
 * @returns the next record.
 */
export function recordMisconceptionEntry(
  record: LearnerRecord,
  evidence: MisconceptionEvidence,
  at: string,
): LearnerRecord {
  const current = record.misconceptions.find(entry => entry.misconceptionId === evidence.misconceptionId)
  const entry: Misconception = {
    misconceptionId: evidence.misconceptionId,
    statement: evidence.statement,
    status: current === undefined || current.status === 'resolved' ? 'detected' : current.status,
    recurrences: (current?.recurrences ?? 0) + 1,
    detectedAt: current?.detectedAt ?? at,
    updatedAt: at,
    caseIds: withCase(current?.caseIds ?? [], evidence.caseId),
    trust: evidence.trust,
  }
  return {
    ...record,
    updatedAt: at,
    misconceptions: upsert(record.misconceptions, entry, value => value.misconceptionId),
  }
}

/**
 * Move one known misconception to a new status.
 * @param record - the learner record at its chain slot.
 * @param misconceptionId - the belief to move; an unknown id is a caller bug and rejects.
 * @param status - where the belief now stands.
 * @param at - ISO-8601 instant of the move.
 * @returns the next record.
 */
export function recordMisconceptionStatus(
  record: LearnerRecord,
  misconceptionId: string,
  status: MisconceptionStatus,
  at: string,
): LearnerRecord {
  const current = record.misconceptions.find(entry => entry.misconceptionId === misconceptionId)
  if (current === undefined) throw new Error(`learner-model: unknown misconception '${misconceptionId}'`)
  const entry: Misconception = { ...current, status, updatedAt: at }
  return {
    ...record,
    updatedAt: at,
    misconceptions: upsert(record.misconceptions, entry, value => value.misconceptionId),
  }
}

/**
 * Record one occurrence of a mistake: a new mistake starts at one occurrence,
 * a known one counts up and unions the concepts it bears on.
 * @param record - the learner record at its chain slot.
 * @param evidence - the recorded occurrence.
 * @param at - ISO-8601 instant of the recording.
 * @returns the next record.
 */
export function recordRecurringMistake(
  record: LearnerRecord,
  evidence: MistakeEvidence,
  at: string,
): LearnerRecord {
  const current = record.recurringMistakes.find(entry => entry.mistakeId === evidence.mistakeId)
  const entry: RecurringMistake = {
    mistakeId: evidence.mistakeId,
    statement: evidence.statement,
    occurrences: (current?.occurrences ?? 0) + 1,
    conceptIds: [...new Set([...(current?.conceptIds ?? []), ...evidence.conceptIds])],
    firstAt: current?.firstAt ?? at,
    lastAt: at,
    caseIds: withCase(current?.caseIds ?? [], evidence.caseId),
    trust: evidence.trust,
  }
  return {
    ...record,
    updatedAt: at,
    recurringMistakes: upsert(record.recurringMistakes, entry, value => value.mistakeId),
  }
}

/**
 * Replace the objective list with the mentor's next objectives. An objective
 * that survives under the same id keeps its original `raisedAt`, so its age
 * stays readable; one that is dropped leaves the list.
 * @param record - the learner record at its chain slot.
 * @param objectives - the next objectives.
 * @param at - ISO-8601 instant of the replacement.
 * @returns the next record.
 */
export function replaceObjectives(
  record: LearnerRecord,
  objectives: readonly ObjectiveInput[],
  at: string,
): LearnerRecord {
  const entries: readonly LearningObjective[] = objectives.map((objective) => {
    const current = record.objectives.find(entry => entry.objectiveId === objective.objectiveId)
    return { ...objective, raisedAt: current?.raisedAt ?? at }
  })
  return { ...record, updatedAt: at, objectives: entries }
}

/**
 * Record one reviewed case in the learner's history, replacing the entry with
 * the same case id and keeping first-review order.
 * @param record - the learner record at its chain slot.
 * @param review - the reviewed case summary.
 * @param at - ISO-8601 instant the case was applied.
 * @returns the next record.
 */
export function recordCaseReview(record: LearnerRecord, review: CaseReviewInput, at: string): LearnerRecord {
  const entry: CaseHistoryEntry = {
    caseId: review.caseId,
    symbol: review.symbol,
    reviewedAt: at,
    outcome: review.outcome,
    conceptsTested: review.conceptsTested,
    lessons: review.lessons,
    mistakes: review.mistakes,
    impacts: review.impacts.map(impact => ({ ...impact, at, trust: review.trust })),
    trust: review.trust,
  }
  return {
    ...record,
    updatedAt: at,
    caseHistory: upsert(record.caseHistory, entry, value => value.caseId),
  }
}
