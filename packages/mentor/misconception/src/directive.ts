/**
 * Directive rendering: one model-facing instruction per pipeline stage, built
 * from the pattern's own correction text and the learner's quoted thesis. A
 * directive's digest identifies the stage's instruction, so a caller delivers
 * it to the mentor once per stage rather than once per step.
 * @module @deepseek-ai/dsh-misconception/src/directive
 */

import { createHash } from 'node:crypto'
import type { CaseReference } from '@deepseek-ai/dsh-learner-model'
import { boundText } from './patterns.ts'
import type {
  ExerciseTask,
  MentorDirective,
  MisconceptionId,
  MisconceptionPattern,
  MisconceptionPipeline,
  MisconceptionStage,
} from './types.ts'

/** Digest length in hex characters; the digest identity only needs to distinguish stages of one misconception. */
const DIGEST_CHARS = 16

/**
 * Stable identity of one stage's directive for one misconception.
 * @param misconceptionId - the occurrence the directive advances.
 * @param stage - the stage the directive serves.
 * @param caseId - the case the directive names, when it names one.
 * @returns a short hex digest.
 */
export function directiveDigest(
  misconceptionId: MisconceptionId,
  stage: MisconceptionStage,
  caseId?: CaseReference,
): string {
  return createHash('sha256')
    .update(`${misconceptionId}\n${stage}\n${caseId ?? ''}`)
    .digest('hex')
    .slice(0, DIGEST_CHARS)
}

/**
 * Render the instruction the mentor agent receives for the pipeline's current
 * stage.
 * @param pipeline - the occurrence, at the stage being served.
 * @param pattern - the catalogued pattern that matched the learner's thesis.
 * @param exercise - the exercise assigned at the exercise stage.
 * @param caseId - the case the learner works on, required from the new-case stage onward.
 * @param maxChars - cap in UTF-16 characters on the rendered text.
 * @returns the directive for that stage.
 * @throws when the stage is `complete`, or when `new-case` is rendered without the case the learner must work on.
 */
export function renderDirective(
  pipeline: MisconceptionPipeline,
  pattern: MisconceptionPattern,
  exercise: ExerciseTask | undefined,
  caseId: CaseReference | undefined,
  maxChars: number,
): MentorDirective {
  const { stage, thesis, misconception } = pipeline
  switch (stage) {
    case 'explain':
      return directive(pipeline, boundText(
        `${misconception} — design error: ${pattern.designError}.\n\n`
        + `Explain it against the learner's thesis "${thesis}", then show the case that breaks it.\n\n`
        + pattern.explanation,
        maxChars,
      ), caseId)
    case 'counterexample':
      return directive(pipeline, boundText(
        `Counterexample for ${misconception}, against the thesis "${thesis}":\n\n`
        + `${pattern.counterexample}\n\nShow it and ask the learner what it does to that thesis.`,
        maxChars,
      ), caseId)
    case 'exercise':
      return directive(pipeline, boundText(
        `Exercise for objective: ${pattern.objective}.\n\n${pattern.exercise}\n\n`
        + 'Assign it, then wait for the learner\'s attempt.',
        maxChars,
      ), caseId, exercise)
    case 'new-case':
      if (caseId === undefined) {
        throw new Error('misconception engine: the new-case stage needs the case the learner must work on')
      }
      return directive(pipeline, boundText(
        `Apply ${pattern.objective} to case ${caseId}.\n\n`
        + 'Have the learner redo the reading on this case and state their thesis in one sentence.',
        maxChars,
      ), caseId)
    case 'reassess':
      return directive(pipeline, boundText(
        `Reassess ${pattern.objective} against the thesis "${thesis}"`
        + `${caseId === undefined ? '' : ` on case ${caseId}`}.\n\n`
        + 'Read the learner\'s new thesis and report whether the misconception still holds.',
        maxChars,
      ), caseId)
    case 'complete':
      throw new Error('misconception engine: a completed cycle renders no directive')
  }
}

/** Assemble one directive from its rendered text and the identity of the stage it serves. */
function directive(
  pipeline: MisconceptionPipeline,
  text: string,
  caseId: CaseReference | undefined,
  exercise?: ExerciseTask,
): MentorDirective {
  return {
    misconceptionId: pipeline.misconceptionId,
    stage: pipeline.stage,
    objective: pipeline.objective,
    text,
    ...exercise === undefined ? {} : { exercise },
    digest: directiveDigest(pipeline.misconceptionId, pipeline.stage, caseId),
  }
}
