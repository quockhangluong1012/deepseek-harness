/**
 * The pure §37 budget rule behind the loops: which recorded allocation governs
 * one task class's work. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/budget
 */

import type { BudgetAllocation } from '@deepseek-ai/dsh-evolution-budget'

/**
 * The allocation that governs one task class's work: the newest recorded
 * allocation for the class, ties broken by batch identity descending so the
 * answer is total. The budget store prices a batch and names its task class, so
 * a class several batches priced is governed by the most recent decision about
 * it, and a class no batch priced returns undefined — an unpriced class has no
 * ceiling to check rather than a zero one.
 * @param allocations - the recorded allocations for one task class.
 * @returns the governing allocation, or undefined when the class is unpriced.
 */
export function governingAllocation(allocations: readonly BudgetAllocation[]): BudgetAllocation | undefined {
  return [...allocations]
    .sort((left, right) => right.at.localeCompare(left.at) || right.batchId.localeCompare(left.batchId))[0]
}
