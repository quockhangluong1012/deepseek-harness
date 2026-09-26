/**
 * Events of the misconception engine. Both are host notifications: a
 * detection and a pipeline transition. Neither reaches a model by itself — a
 * caller that puts teaching text in front of a model owns that message.
 * @module @deepseek-ai/dsh-misconception/src/events
 */

import type { LearnerId } from '@deepseek-ai/dsh-learner-model'
import type { MisconceptionDetection, MisconceptionFact, MisconceptionId, MisconceptionStage } from './types.ts'

/** One pipeline stage replaced by the next. */
export interface MisconceptionStageChange {
  /** The occurrence that advanced. */
  readonly misconceptionId: MisconceptionId
  /** The learner whose cycle advanced. */
  readonly learnerId: LearnerId
  /** The stage the pipeline left. */
  readonly from: MisconceptionStage
  /** The stage the pipeline entered. */
  readonly to: MisconceptionStage
  /** The fact that completed the stage. */
  readonly fact: MisconceptionFact['kind']
  /** What the entered stage still waits for; absent once it can proceed. */
  readonly waitingFor?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One learner thesis was judged against the catalogue and matched, with
     * the observations that contradict it. Emitted after the learner record,
     * the pipeline row, and the kernel claim are written.
     * @param detection - the thesis, the misconception, the design error, and the contradiction count.
     * @mode emit
     */
    'mentor/misconception-detected'(detection: MisconceptionDetection): void

    /**
     * One pipeline stage completed and the next began. Emitted after the
     * durable row moved.
     * @param change - the occurrence, the stages left and entered, the completing fact, and the new stage's wait.
     * @mode emit
     */
    'mentor/misconception-stage'(change: MisconceptionStageChange): void
  }
}
