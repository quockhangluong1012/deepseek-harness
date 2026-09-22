/**
 * Pure helpers for uncertainty-driven learning: the canonical §43 kind order,
 * the corroborated priority rule, and the grouped evaluation-task queue. No
 * I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-uncertainty/src/uncertainty
 */

import type { EvaluationTask, UncertaintyKind, UncertaintySignal } from './types.ts'

/** The five §43 uncertainty kinds, in canonical spec order. */
export const UNCERTAINTY_KINDS = [
  'disagreement',
  'low-confidence',
  'instability',
  'retrieval-ambiguity',
  'conflicting-evidence',
] as const satisfies readonly UncertaintyKind[]

/**
 * The queue priority of one evaluation task: the strongest signal plus a
 * corroboration bonus per distinct kind past the first — independent kinds
 * agreeing that a task is uncertain counts more than one loud signal — capped
 * at 1 so no task outranks certainty.
 * @param scores - the signal strengths behind the task.
 * @param distinctKinds - how many distinct §43 kinds those signals cover.
 * @param corroborationBonus - bonus added per distinct kind past the first.
 * @returns the priority, between 0 and 1 inclusive.
 */
export function priorityOf(scores: readonly number[], distinctKinds: number, corroborationBonus: number): number {
  const top = scores.length === 0 ? 0 : Math.max(...scores)
  return Math.min(1, top + corroborationBonus * Math.max(0, distinctKinds - 1))
}

/**
 * The sort key of a task group: named tasks sort lexically under a `0` prefix
 * while a null (skill-wide) task sorts after every named one under `1`.
 * @param taskId - the task identity, or null for a skill-wide group.
 * @returns the lexical sort key.
 */
function taskSortKey(taskId: string | null): string {
  if (taskId === null) return '1'
  return `0${taskId}`
}

/**
 * Group signals into evaluation tasks by skill and task identity — a null
 * task identity is its own skill-wide group — then sort the queue by priority
 * descending, skill ascending, and task identity (null last, then lexical) so
 * the order is deterministic.
 * @param signals - the uncertainty signals to aggregate.
 * @param corroborationBonus - bonus added per distinct kind past the first.
 * @returns the prioritized evaluation tasks.
 */
export function queueFor(signals: readonly UncertaintySignal[], corroborationBonus: number): EvaluationTask[] {
  const groups = new Map<string, { skill: string; taskId: string | null; scores: number[]; kinds: Set<UncertaintyKind> }>()
  for (const signal of signals) {
    const key = JSON.stringify([signal.skill, signal.taskId])
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { skill: signal.skill, taskId: signal.taskId, scores: [signal.score], kinds: new Set([signal.kind]) })
    } else {
      group.scores.push(signal.score)
      group.kinds.add(signal.kind)
    }
  }
  const tasks: EvaluationTask[] = [...groups.values()].map((group) => {
    const kinds = UNCERTAINTY_KINDS.filter(kind => group.kinds.has(kind))
    return {
      skill: group.skill,
      taskId: group.taskId,
      kinds,
      topScore: Math.max(0, ...group.scores),
      priority: priorityOf(group.scores, kinds.length, corroborationBonus),
      signals: group.scores.length,
    }
  })
  tasks.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority
    if (left.skill !== right.skill) return left.skill < right.skill ? -1 : 1
    return taskSortKey(left.taskId) < taskSortKey(right.taskId) ? -1 : 1
  })
  return tasks
}
