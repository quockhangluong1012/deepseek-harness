/**
 * Task overlap: whether a delegation repeats work one of the parent's children
 * already has or already finished, decided deterministically from the task
 * objectives.
 *
 * An objective is the delegation's own `description`, the short summary the
 * model authored for the task and the text a child listing shows. Two
 * objectives are compared by the Dice coefficient of their token sets, so the
 * comparison is order-free, cheap, and identical on replay: no model call, no
 * clock, no filesystem read.
 *
 * The policy this module implements, in one table:
 *
 * | Best match    | At or above reuse (0.9)                          | At or above shared (0.55) |
 * |---------------|--------------------------------------------------|---------------------------|
 * | in flight     | `merge` — no second child, the running one covers it | `merge`                   |
 * | completed, result retained | `reuse` — the earlier result answers it | `narrow`                  |
 * | completed, no result | `avoid` — refuse, naming the child that already did it | `narrow`          |
 *
 * Below the shared threshold the task is new and the spawn proceeds.
 *
 * @module @deepseek-ai/dsh-agent-kernel/task-overlap
 */

import type { DelegationPolicy } from './delegation-policy.ts'

/** Similarity at or above which two objectives are the same task. */
export const TASK_OVERLAP_REUSE_THRESHOLD = 0.9

/** Similarity at or above which two objectives share part of their work. */
export const TASK_OVERLAP_SHARED_THRESHOLD = 0.55

/**
 * Words dropped before comparison, as a static string-keyed lookup table. A
 * delegation objective is a short summary, so function words dominate its
 * token count; keeping them would make every pair of short objectives look
 * alike.
 */
const OBJECTIVE_STOP_WORDS: Readonly<Record<string, true>> = {
  a: true, an: true, and: true, are: true, as: true, at: true, be: true, by: true,
  for: true, from: true, in: true, into: true, is: true, it: true, its: true,
  of: true, on: true, or: true, that: true, the: true, their: true, then: true,
  this: true, to: true, with: true,
}

/**
 * The distinct content words of one objective.
 * @param objective - the delegation's `description`.
 * @returns the lower-cased alphanumeric words, without stop words or one-character tokens.
 */
function objectiveTokens(objective: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const word of objective.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length > 1 && OBJECTIVE_STOP_WORDS[word] !== true) tokens.add(word)
  }
  return tokens
}

/**
 * How much two objectives share, as the Dice coefficient of their token sets.
 * @param left - one objective.
 * @param right - the other objective.
 * @returns a value in `[0, 1]`; two objectives that share no content word, or an
 *   objective with no content word at all, score 0.
 */
export function objectiveOverlap(left: string, right: string): number {
  const leftTokens = objectiveTokens(left)
  const rightTokens = objectiveTokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let shared = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size)
}

/** A child of this parent that is still in flight. */
export interface ActiveChildTask {
  /** Durable child identity, as the spawn boundary knows it. */
  readonly childId: string
  /** The delegation's `description`. */
  readonly objective: string
}

/** A child of this parent that has settled. */
export interface CompletedChildTask extends ActiveChildTask {
  /** The result text this session retained for the completed child, absent when none was kept. */
  readonly result?: string
}

/** What one would-be spawn is compared against. */
export interface TaskOverlapInput {
  /** The objective of the spawn being considered. */
  readonly objective: string
  /** Children of this parent still in flight. */
  readonly active: readonly ActiveChildTask[]
  /** Children of this parent that settled, most recent first. */
  readonly completed: readonly CompletedChildTask[]
}

/**
 * What the boundary does about one spawn once its overlap is known. Every
 * decision names the overlapping child it decided on, so the reader can see
 * which delegation the task was found to repeat.
 */
export type TaskOverlapDecision =
  | { readonly kind: 'spawn' }
  | { readonly kind: 'reuse'; readonly childId: string; readonly objective: string; readonly result: string }
  | { readonly kind: 'merge'; readonly childId: string; readonly objective: string }
  | { readonly kind: 'narrow'; readonly childId: string; readonly objective: string; readonly overlap: number }
  | { readonly kind: 'avoid'; readonly childId: string; readonly objective: string; readonly reason: string }

/** The best-scoring candidate, in flight or completed. */
interface OverlapMatch {
  readonly score: number
  readonly candidate: ActiveChildTask
  readonly active: boolean
  readonly result?: string
}

/**
 * Decide what to do about one spawn that may repeat earlier work. Detection is
 * this policy's own switch: with `duplicateTaskDetection` false the boundary
 * admits every spawn and compares nothing. In-flight children are compared
 * before completed ones, and only a strictly higher score replaces the leader,
 * so a tie always resolves to the first candidate.
 * @param policy - the resolved delegation policy.
 * @param input - the objective and this parent's in-flight and completed children.
 * @returns the decision; `spawn` when detection is off or nothing overlaps
 *   enough to act on.
 */
export function taskOverlapDecision(policy: DelegationPolicy, input: TaskOverlapInput): TaskOverlapDecision {
  if (!policy.duplicateTaskDetection) return { kind: 'spawn' }
  let best: OverlapMatch | undefined
  const consider = (candidate: ActiveChildTask, active: boolean, result: string | undefined): void => {
    const score = objectiveOverlap(input.objective, candidate.objective)
    if (best !== undefined && score <= best.score) return
    best = { score, candidate, active, ...result === undefined ? {} : { result } }
  }
  for (const candidate of input.active) consider(candidate, true, undefined)
  for (const candidate of input.completed) consider(candidate, false, candidate.result)
  if (best === undefined || best.score < TASK_OVERLAP_SHARED_THRESHOLD) return { kind: 'spawn' }
  const { childId, objective } = best.candidate
  if (best.active) return { kind: 'merge', childId, objective }
  if (best.score < TASK_OVERLAP_REUSE_THRESHOLD) return { kind: 'narrow', childId, objective, overlap: best.score }
  return best.result === undefined
    ? {
      kind: 'avoid',
      childId,
      objective,
      reason: `a child already completed this task (${childId}) and this session retains no result to reuse`,
    }
    : { kind: 'reuse', childId, objective, result: best.result }
}
