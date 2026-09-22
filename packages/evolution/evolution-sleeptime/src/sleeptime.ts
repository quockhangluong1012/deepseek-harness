/**
 * Pure helpers for sleep-time compute: the expected-net economics of
 * precomputing one anticipated task, the worth-it decision, the greedy
 * budgeted plan, and the realized savings of a cached artifact. No I/O, no
 * domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-sleeptime/src/sleeptime
 */

import type { AnticipatedTask, PrecomputeKind, SleeptimeDecision } from './types.ts'

/** The three §25 precompute kinds, in canonical order. */
export const PRECOMPUTE_KINDS: readonly PrecomputeKind[] = ['summary', 'retrieval-index', 'candidate-plan']

/**
 * The expected net tokens of precomputing one anticipated task: the
 * likelihood-weighted expected future savings minus the estimated offline
 * cost. A task that never materializes still costs its precompute.
 * @param task - the anticipated task's likelihood and savings shape.
 * @param estimatedCostTokens - the estimated offline cost of precomputing.
 * @returns the expected net tokens, negative when the cost dominates.
 */
export function expectedNet(
  task: { likelihood: number; expectedQueries: number; expectedSavingTokens: number },
  estimatedCostTokens: number,
): number {
  return task.likelihood * task.expectedQueries * task.expectedSavingTokens - estimatedCostTokens
}

/**
 * Whether precomputing one anticipated task is worth its estimated offline
 * cost. Worth it needs a strictly positive net: a net of exactly zero spends
 * idle time for nothing.
 * @param task - the anticipated task to judge.
 * @param estimatedCostTokens - the estimated offline cost of precomputing.
 * @returns the decision with its net and its reason naming the numbers.
 */
export function decideWorth(task: AnticipatedTask, estimatedCostTokens: number): SleeptimeDecision {
  const net = expectedNet(task, estimatedCostTokens)
  return {
    taskId: task.taskId,
    domain: task.domain,
    worthIt: net > 0,
    expectedNet: net,
    reason: `net ${net} tokens (likelihood ${task.likelihood} × ${task.expectedQueries} queries × ${task.expectedSavingTokens} saved − cost ${estimatedCostTokens})`,
  }
}

/**
 * The greedy budgeted plan over anticipated tasks: worth-it decisions sorted
 * net descending with task-id ascending tie-break, taken in order while the
 * cumulative estimated cost still fits the offline budget. Tasks that are not
 * worth precomputing never enter the plan.
 * @param tasks - the anticipated tasks to choose from.
 * @param estimatedCostTokens - the estimated offline cost of one precompute.
 * @param budgetTokens - the total offline budget available.
 * @returns the planned decisions, best net first.
 */
export function planFor(
  tasks: readonly AnticipatedTask[],
  estimatedCostTokens: number,
  budgetTokens: number,
): SleeptimeDecision[] {
  const candidates = tasks
    .map(task => decideWorth(task, estimatedCostTokens))
    .filter(decision => decision.worthIt)
  candidates.sort((left, right) => right.expectedNet - left.expectedNet || left.taskId.localeCompare(right.taskId))
  const planned: SleeptimeDecision[] = []
  let spent = 0
  for (const decision of candidates) {
    if (spent + estimatedCostTokens > budgetTokens) continue
    spent += estimatedCostTokens
    planned.push(decision)
  }
  return planned
}

/**
 * The realized savings of a cached artifact: tokens its hits have saved minus
 * the offline tokens spent precomputing it. Negative while the precompute has
 * not yet paid back its cost.
 * @param artifact - the artifact's savings shape.
 * @returns the realized net tokens.
 */
export function savingsOf(artifact: { savedTokens: number; offlineCostTokens: number }): number {
  return artifact.savedTokens - artifact.offlineCostTokens
}
