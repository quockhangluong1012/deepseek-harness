/**
 * Vocabulary of the mentor quality loop: the §20 stages, the one action the
 * loop takes at a step, and the position a caller reads or observes.
 * @module @deepseek-ai/dsh-mentor-loop/src/types
 */

import type { LearnerId } from '@deepseek-ai/dsh-learner-model'
import type { MisconceptionId, MisconceptionStage } from '@deepseek-ai/dsh-misconception'

/**
 * One §20 mentor loop stage. `observe`, `evaluate`, and `devil-advocate` read
 * what the session already holds; `misconception-detection` runs the engine;
 * `teach`, `exercise`, and `reassess` serve the engine pipeline; and
 * `learner-model-update` closes the cycle on the learner record.
 */
export type MentorStage =
  | 'observe'
  | 'evaluate'
  | 'devil-advocate'
  | 'misconception-detection'
  | 'teach'
  | 'exercise'
  | 'reassess'
  | 'learner-model-update'

/** The single action one loop step takes, or `none` while the loop waits. */
export type MentorLoopAction =
  /** The loop waits for the named fact. */
  | 'none'
  /** Record a detection for the learner's stated thesis through the misconception engine. */
  | 'detect'
  /** Complete the current pipeline stage with the fact the session now shows. */
  | 'advance'
  /** Put the current stage's directive in front of the mentor agent. */
  | 'deliver'

/** Where one mentor session stands in the §20 loop. */
export interface MentorLoopPosition {
  /** The stage that has not completed yet. */
  readonly stage: MentorStage
  /** The action the loop takes now; `none` while it waits. */
  readonly action: MentorLoopAction
  /** What the loop waits for, named; absent once nothing stands in the way. */
  readonly waitingFor?: string
  /** The learner's newest thesis, as stated, once the log holds one. */
  readonly thesis?: string
  /** The occurrence the loop works on, once the catalogue matched the thesis. */
  readonly misconceptionId?: MisconceptionId
  /** The stage of that occurrence's pipeline. */
  readonly pipelineStage?: MisconceptionStage
}

/** One loop position announced for a learner. */
export interface MentorLoopReport extends MentorLoopPosition {
  /** The learner the position belongs to. */
  readonly learnerId: LearnerId
}

/** Source of every directive this loop injects; the digest identifies the stage's instruction. */
export interface MentorDirectiveSource {
  kind: 'mentor-loop'
  /** Digest of the engine directive the message carries. */
  digest: string
  /** The occurrence the directive advances. */
  misconceptionId: string
  /** The pipeline stage the directive served. */
  stage: MisconceptionStage
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'mentor-loop': MentorDirectiveSource
  }
}
