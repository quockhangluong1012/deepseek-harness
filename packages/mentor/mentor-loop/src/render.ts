/**
 * Rendering of one injected directive. The message carries the §20 stage's
 * request and the engine's own instruction; it is model-facing text, so it is
 * bounded at the deployment's cap.
 * @module @deepseek-ai/dsh-mentor-loop/src/render
 */

import type { MentorDirective, MisconceptionStage } from '@deepseek-ai/dsh-misconception'
import { boundText } from '@deepseek-ai/dsh-misconception'

/** What the mentor agent is asked to do at one pipeline stage. */
function requestOf(stage: MisconceptionStage): string {
  switch (stage) {
    case 'explain':
      return 'correct this misconception in your next reply, in the learner\'s own terms'
    case 'counterexample':
      return 'show the counterexample below and ask what it does to the learner\'s thesis'
    case 'exercise':
      return 'assign the exercise below, then wait for the learner'
    case 'new-case':
      return 'set the case below as the learner\'s next reading'
    case 'reassess':
      return 'read the learner\'s new work and reassess it against the objective below'
    case 'complete':
      throw new Error('mentor loop: a completed cycle renders no directive')
  }
}

/**
 * Render one directive as the text the mentor agent receives.
 * @param directive - the engine's instruction for the pipeline's current stage.
 * @param maxChars - cap in UTF-16 characters on the emitted text.
 * @returns the bounded message text.
 */
export function renderMentorDirective(directive: MentorDirective, maxChars: number): string {
  const header = `Mentor loop — ${requestOf(directive.stage)}.`
  const exercise = directive.exercise === undefined
    ? ''
    : `\n\nExercise ${directive.exercise.exerciseId} targets: ${directive.exercise.objective}.`
  return boundText(`${header}${exercise}\n\n${directive.text}`, maxChars)
}
