/**
 * The misconception pipeline state machine: which stage follows which, which
 * fact completes a stage, and what a stage that cannot advance is waiting for.
 * The transitions are pure — the engine owns durability and the learner record.
 * @module @deepseek-ai/dsh-misconception/src/pipeline
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { LearnerId } from '@deepseek-ai/dsh-learner-model'
import type {
  ExerciseTask,
  MisconceptionFact,
  MisconceptionId,
  MisconceptionStage,
} from './types.ts'

/**
 * Every stage in one cycle, in pipeline order. `complete` ends a cycle; a
 * `repeated` reassessment returns to `explain`.
 */
export const MISCONCEPTION_STAGES = [
  'explain',
  'counterexample',
  'exercise',
  'new-case',
  'reassess',
  'complete',
] as const satisfies readonly MisconceptionStage[]

/**
 * The identity one learner's occurrence of one pattern gets. It is derived
 * from the learner and the pattern rather than generated, so a later
 * occurrence updates the same pipeline and the learner record counts it as a
 * recurrence instead of a second misconception.
 * @param learnerId - the learner whose record carries the occurrence.
 * @param patternId - the catalogued pattern that matched.
 * @returns the derived occurrence identity.
 */
export function misconceptionIdOf(learnerId: LearnerId, patternId: string): MisconceptionId {
  return brandString<MisconceptionId>(`${learnerId}/${patternId}`)
}

/**
 * The exercise identity one misconception's exercise gets, derived so a
 * reassessment can name the exercise the learner worked.
 * @param misconceptionId - the occurrence the exercise belongs to.
 * @returns the derived exercise identity.
 */
export function exerciseIdOf(misconceptionId: MisconceptionId): string {
  return `${misconceptionId}:exercise`
}

/**
 * The learning-objective identity one misconception's objective gets, derived
 * so later writes replace the learner's objective instead of adding a second.
 * @param misconceptionId - the occurrence the objective belongs to.
 * @returns the derived objective identity.
 */
export function objectiveIdOf(misconceptionId: MisconceptionId): string {
  return `${misconceptionId}:objective`
}

/**
 * Build the exercise one misconception's exercise stage assigns.
 * @param misconceptionId - the occurrence the exercise belongs to.
 * @param objective - the learning objective the exercise targets.
 * @param prompt - the exercise text the deployment declared for the pattern.
 * @returns the exercise the mentor assigns.
 */
export function exerciseOf(misconceptionId: MisconceptionId, objective: string, prompt: string): ExerciseTask {
  return { exerciseId: exerciseIdOf(misconceptionId), misconceptionId, objective, prompt }
}

/** Throw unless the offered fact is the kind the stage accepts. */
function requireFact<K extends MisconceptionFact['kind']>(
  stage: MisconceptionStage,
  fact: MisconceptionFact,
  kind: K,
): asserts fact is Extract<MisconceptionFact, { kind: K }> {
  if (fact.kind !== kind) {
    throw new Error(`misconception pipeline: the ${stage} stage completes with '${kind}', not '${fact.kind}'`)
  }
}

/**
 * The stage that follows once the offered fact completes the current one.
 * @param stage - the stage that has not completed yet.
 * @param fact - the observed fact offered as its completion.
 * @returns the next stage; `explain` after a repeated reassessment, `complete` after a resolved one.
 * @throws when the stage is already complete or the fact is not the kind the stage accepts.
 */
export function completeStage(stage: MisconceptionStage, fact: MisconceptionFact): MisconceptionStage {
  switch (stage) {
    case 'explain':
      requireFact(stage, fact, 'delivered')
      return 'counterexample'
    case 'counterexample':
      requireFact(stage, fact, 'delivered')
      return 'exercise'
    case 'exercise':
      requireFact(stage, fact, 'attempted')
      return 'new-case'
    case 'new-case':
      requireFact(stage, fact, 'case-selected')
      return 'reassess'
    case 'reassess':
      requireFact(stage, fact, 'reassessed')
      return fact.outcome === 'repeated' ? 'explain' : 'complete'
    case 'complete':
      throw new Error('misconception pipeline: the complete stage accepts no further fact')
  }
}

/**
 * What one stage needs before it can complete, as a phrase a host surfaces to
 * a mentor or a maintainer. `complete` needs nothing.
 * @param stage - the stage that has not completed yet.
 * @param misconception - the misconception the stage works on, named for the reader.
 * @param exerciseId - the exercise identity the stage refers to, when it has one.
 * @returns the named wait, or undefined at `complete`.
 */
export function waitingForOf(
  stage: MisconceptionStage,
  misconception: string,
  exerciseId: string | undefined,
): string | undefined {
  switch (stage) {
    case 'explain':
      return `delivery of the explanation for ${misconception}`
    case 'counterexample':
      return `delivery of the counterexample for ${misconception}`
    case 'exercise':
      return `the learner attempt at exercise ${exerciseId ?? ''}`
    case 'new-case':
      return `a case artifact for ${misconception}`
    case 'reassess':
      return `the learner reassessment after exercise ${exerciseId ?? ''}`
    case 'complete':
      return undefined
  }
}
