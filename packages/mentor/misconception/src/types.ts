/**
 * Vocabulary of the misconception engine: the pattern catalogue a deployment
 * declares, the finding one stated thesis produces, the durable pipeline that
 * finding starts, and the directives each pipeline stage renders.
 * @module @deepseek-ai/dsh-misconception/src/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EvidenceId, TaskClaimId } from '@deepseek-ai/dsh-agent-kernel'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CaseReference, LearnerId } from '@deepseek-ai/dsh-learner-model'

/** Identity of one learner's occurrence of one misconception, derived from the learner and the pattern. */
export type MisconceptionId = Branded<'MisconceptionId'>

/**
 * One misconception a deployment declares it can detect. A pattern is
 * deployment configuration, not a code constant: the ICT profile supplies its
 * own catalogue from its cordis.yml row.
 */
export interface MisconceptionPattern {
  /** Stable identity of this pattern within the deployment's catalogue. */
  id: string
  /** The misconception, named in the learner's own terms. */
  misconception: string
  /** The design error behind the misconception. */
  designError: string
  /** The learning objective an exercise for this misconception targets. */
  objective: string
  /** Distinctive phrases whose presence in a stated thesis indicates this misconception. */
  triggers: string[]
  /** The correction the mentor delivers at the explain stage. */
  explanation: string
  /** The worked counterexample the mentor delivers at the counterexample stage. */
  counterexample: string
  /** The exercise prompt the mentor assigns at the exercise stage. */
  exercise: string
}

/** The stage of one pipeline that has not completed yet; `complete` ends a cycle. */
export type MisconceptionStage =
  /** The design error is explained against the learner's thesis. */
  | 'explain'
  /** The case that breaks the thesis is shown. */
  | 'counterexample'
  /** An exercise targeting the misconception's objective is assigned. */
  | 'exercise'
  /** The learner redoes the reading on a new case. */
  | 'new-case'
  /** The learner's new thesis is judged against the pattern. */
  | 'reassess'
  /** The learner stopped showing the misconception; the cycle is over. */
  | 'complete'

/**
 * One fact the caller observed that completes the current stage. Each stage
 * accepts exactly one fact kind, and {@link MisconceptionEngine.advance}
 * refuses a fact the current stage does not accept.
 */
export type MisconceptionFact =
  /** The stage's directive reached the learner. */
  | { readonly kind: 'delivered' }
  /** The learner worked the assigned exercise. */
  | { readonly kind: 'attempted'; readonly attempt: string }
  /** The learner was given one case from their own case history. */
  | { readonly kind: 'case-selected'; readonly caseId: CaseReference }
  /** The learner's new thesis either shows the misconception again or no longer does. */
  | { readonly kind: 'reassessed'; readonly outcome: 'repeated' | 'resolved' }

/** One exercise assigned for a misconception, aimed at its objective. */
export interface ExerciseTask {
  /** Stable identity of the exercise, derived from the misconception. */
  readonly exerciseId: string
  /** The misconception this exercise trains away. */
  readonly misconceptionId: MisconceptionId
  /** The learning objective the exercise targets. */
  readonly objective: string
  /** The exercise the learner receives. */
  readonly prompt: string
}

/** What the current stage needs before it can complete. */
export interface MisconceptionPipeline {
  /** Identity of this learner's occurrence of this misconception. */
  readonly misconceptionId: MisconceptionId
  /** The learner whose record carries the misconception and its objective. */
  readonly learnerId: LearnerId
  /** The catalogued pattern that matched the thesis. */
  readonly patternId: string
  /** The thesis that exposed the misconception, as the learner stated it. */
  readonly thesis: string
  /** The misconception named by the pattern. */
  readonly misconception: string
  /** The design error named by the pattern. */
  readonly designError: string
  /** The objective an exercise for this misconception targets. */
  readonly objective: string
  /** The stage that has not completed yet. */
  readonly stage: MisconceptionStage
  /** The observations that contradicted the thesis. */
  readonly evidence: readonly EvidenceId[]
  /** What the current stage waits for; absent once the stage can proceed. */
  readonly waitingFor?: string
  /** The exercise assigned at the exercise stage. */
  readonly exercise?: ExerciseTask
  /** The case the learner is working through after the new-case stage. */
  readonly caseId?: CaseReference
  /** The learner's last attempt at the exercise. */
  readonly attempt?: string
  /** ISO timestamp of the first detection. */
  readonly detectedAt: string
  /** ISO timestamp of the last write. */
  readonly updatedAt: string
}

/** One model-facing instruction for the mentor, complete for the pipeline's current stage. */
export interface MentorDirective {
  /** The learner's occurrence this directive advances. */
  readonly misconceptionId: MisconceptionId
  /** The stage this directive serves. */
  readonly stage: MisconceptionStage
  /** The learning objective the stage works toward. */
  readonly objective: string
  /** The instruction the mentor agent receives. */
  readonly text: string
  /** The exercise to assign; present at the exercise stage. */
  readonly exercise?: ExerciseTask
  /** Stable identity of this directive, so a caller can deliver it once per stage. */
  readonly digest: string
}

/** One evidence-backed finding: the learner's thesis, the misconception, and the design error behind it. */
export interface MisconceptionDetection {
  /** Identity of this learner's occurrence of this misconception. */
  readonly misconceptionId: MisconceptionId
  /** The learner whose record carries the finding. */
  readonly learnerId: LearnerId
  /** The catalogued pattern that matched the thesis. */
  readonly patternId: string
  /** The thesis, as the learner stated it. */
  readonly thesis: string
  /** The misconception named by the pattern. */
  readonly misconception: string
  /** The design error behind the misconception. */
  readonly designError: string
  /** The objective an exercise for this misconception targets. */
  readonly objective: string
  /** The observations that contradicted the thesis. */
  readonly evidence: readonly EvidenceId[]
  /** The claim the kernel recorded for this finding; absent when no kernel is mounted. */
  readonly claimId?: TaskClaimId
  /** How many times the learner has shown this misconception, read from the learner record. */
  readonly occurrences: number
  /** Whether this occurrence repeats an earlier one. */
  readonly recurring: boolean
  /** The stage the pipeline stood at when the finding was recorded. */
  readonly stage: MisconceptionStage
  /** ISO timestamp of the detection. */
  readonly detectedAt: string
}

/** One learner thesis the engine is asked to judge, with the agent that asserts the finding. */
export interface ThesisInput {
  /** The live agent whose task records the finding as a claim. */
  readonly agent: Agent
  /** The learner the analysis belongs to. */
  readonly learnerId: LearnerId
  /** The thesis, quoted from the learner's analysis. */
  readonly thesis: string
  /** The observations that contradict the thesis, already recorded for the session. */
  readonly evidence: readonly EvidenceId[]
  /** The case the analysis reviewed, when one is known. */
  readonly caseId?: CaseReference
}

/** One observed fact offered as the completion of a pipeline stage. */
export interface AdvanceRequest {
  /** The learner's occurrence being advanced. */
  readonly misconceptionId: MisconceptionId
  /** The fact the caller observed; it must complete the pipeline's current stage. */
  readonly fact: MisconceptionFact
}
