/**
 * Pure curriculum derivation: one training/evaluation task per measured
 * capability gap, grounded in the gap's most decisive failure gists. Nothing
 * here calls a model — the gap evidence IS the curriculum signal (§10), so a
 * task states the recurring failure a run should reproduce and recover from.
 * @module @deepseek-ai/dsh-evolution-curriculum/src/derive
 */

import type { CurriculumGap } from './types.ts'

/** Cap on the failure gists one task cites, so the task text stays bounded. */
export const TASK_GIST_LIMIT = 3

/** Cap on task text size, so a proposal never carries an unbounded body. */
export const TASK_TEXT_LIMIT = 240

/**
 * One staged task before it receives its identity: the capability, its
 * grounded task text, and the evidence it was derived from.
 */
export interface DerivedTask {
  capability: string
  task: string
  sourceSessions: readonly string[]
  gists: readonly string[]
}

/**
 * Derive one task per capability gap that carries failure evidence, most
 * evidence first. A gap with no gists proposes nothing; a task cites at most
 * {@link TASK_GIST_LIMIT} gists and is clipped to {@link TASK_TEXT_LIMIT}.
 * @param gaps - measured gaps, in caller order.
 * @returns the derived tasks.
 */
export function deriveTasks(gaps: readonly CurriculumGap[]): DerivedTask[] {
  const withEvidence = gaps
    .filter(gap => gap.failureGists.length > 0)
    .sort((left, right) =>
      right.failureGists.length - left.failureGists.length
      || right.sourceSessions.length - left.sourceSessions.length)
  return withEvidence.map(gap => ({
    capability: gap.capability,
    task: clip(taskOf(gap)),
    sourceSessions: [...gap.sourceSessions],
    gists: gap.failureGists.slice(0, TASK_GIST_LIMIT),
  }))
}

/** Build one gap's task text from its failure evidence. */
function taskOf(gap: CurriculumGap): string {
  const top = gap.failureGists.slice(0, TASK_GIST_LIMIT).map(gist => `'${gist}'`).join('; ')
  const sessions = gap.sourceSessions.length === 1 ? 'one session' : `${gap.sourceSessions.length} sessions`
  return `Reproduce and recover from the recurring failure: ${top} — observed in ${sessions} while ${gap.capability} was in play.`
}

/** Clip a task to the text budget; a body beyond it reports its own length. */
function clip(text: string): string {
  return text.length <= TASK_TEXT_LIMIT
    ? text
    : `${text.slice(0, TASK_TEXT_LIMIT - 1)}…`
}
