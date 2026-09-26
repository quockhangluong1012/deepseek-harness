/**
 * Intake resolution for the change contract a caller declares. This is the one
 * place a declared boundary is validated before it becomes part of the task
 * contract, so a boundary that could never decide anything fails at intake
 * instead of loading as a contract every later comparison passes.
 *
 * @module @deepseek-ai/dsh-agent-kernel/change-contract
 */

import type { ChangeContract } from './types.ts'

/** The glob-carrying fields of a contract, each named as a refusal names it. */
const GLOB_FIELDS = ['expectedFiles', 'allowedFiles', 'mustPreserve', 'forbiddenChanges', 'expectedTests'] as const

/**
 * Validate one declared change contract, or read the absence of one.
 * @param declared - the boundary a caller declared, when it declared one.
 * @returns the declared contract, or undefined when the caller declared none.
 * @throws When the goal is blank or a glob is blank: a boundary entry that
 *   names nothing would be compared as though it bounded nothing, and the
 *   declaration would decide a criterion without saying what it decided.
 */
export function resolveChangeContract(declared: ChangeContract | undefined): ChangeContract | undefined {
  if (declared === undefined) return undefined
  if (declared.goal.trim().length === 0) {
    throw new Error('agent-kernel: a change contract states its goal')
  }
  for (const field of GLOB_FIELDS) {
    const blank = declared[field].find(glob => glob.trim().length === 0)
    if (blank !== undefined) {
      throw new Error(`agent-kernel: a change contract declares a blank ${field} glob, which bounds nothing`)
    }
  }
  return declared
}
