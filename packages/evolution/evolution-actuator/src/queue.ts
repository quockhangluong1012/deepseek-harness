/**
 * The pure mapping behind the uncertainty drain: which benchmark task one
 * queued evaluation task becomes. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/queue
 */

import type { BenchmarkInput } from '@deepseek-ai/dsh-evolution-benchmark'
import { MINED_TASK } from '@deepseek-ai/dsh-evolution-benchmark'
import type { EvaluationTask, UncertaintySignal } from '@deepseek-ai/dsh-evolution-uncertainty'

/**
 * The benchmark task one queued evaluation task becomes (§43: uncertain
 * outputs "become high-value tasks for additional evaluation"). The capability
 * is the skill, and the task text with its gists is the strongest signal's
 * note. No store holds a generated task for an uncertainty signal — the
 * curriculum is the engine's task generator, and this path records what was
 * observed — so the note is the task text rather than a synthesized prompt.
 * Sessions stay empty because a §43 signal carries no session identity.
 * @param task - the queued evaluation task.
 * @param signals - the signals grouped into that task, in any order.
 * @returns the task to admit.
 */
export function benchmarkInput(task: EvaluationTask, signals: readonly UncertaintySignal[]): BenchmarkInput {
  const ordered = [...signals].sort((left, right) => right.score - left.score || right.at.localeCompare(left.at))
  const strongest = ordered[0]
  if (strongest === undefined) {
    throw new Error(`evolution-actuator: evaluation task '${task.skill}' has no signal to become a benchmark task`)
  }
  return {
    capability: task.skill,
    task: strongest.detail,
    gists: [...new Set(ordered.map(signal => signal.detail))],
    sourceSessions: [],
    ...MINED_TASK,
  }
}
