/**
 * Event of the mentor loop: the position it reached for one learner. Emitted
 * only when the position changes, so a listener sees each stage and each named
 * wait once.
 * @module @deepseek-ai/dsh-mentor-loop/src/events
 */

import type { MentorLoopReport } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One learner's mentor loop position changed: the stage reached, the
     * action taken, and what the loop waits for when nothing can advance.
     * @param report - the learner and the position the loop now stands at.
     * @mode emit
     */
    'mentor/loop-position'(report: MentorLoopReport): void
  }
}
