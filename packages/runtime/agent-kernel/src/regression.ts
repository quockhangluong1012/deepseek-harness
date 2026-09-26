/**
 * The regression leg of the repair loop (§8.5): after a repair's targeted
 * verification passes, the criteria an earlier verification of the same task
 * passed must still pass.
 *
 * The leg compares results the verifier registry already produced. A criterion
 * the S6 result cache answered for the current repository digest was not re-run,
 * so nothing here starts a verifier or spends a command: the registry owns the
 * single no-double-work mechanism, and this module owns only the attribution of
 * a repair that broke something.
 *
 * @module @deepseek-ai/dsh-agent-kernel/regression
 */

import type { CriterionResult, VerificationResult } from './types.ts'

/**
 * The criteria that regressed: they passed in an earlier verification of the
 * same task and do not pass in this one.
 *
 * A verification of another task is no baseline, so the first verification of a
 * task reports no regression however the previous task ended.
 * @param previous - the verification the repair answered, when one is folded.
 * @param current - the verification just recorded.
 * @returns the regressed criteria, in the current verification's criterion order.
 */
export function regressedCriteria(previous: VerificationResult | undefined, current: VerificationResult): readonly CriterionResult[] {
  if (previous === undefined || previous.taskId !== current.taskId) return []
  const passedEarlier = new Set(previous.criterionResults
    .filter(result => result.status === 'pass')
    .map(result => result.criterionId))
  return current.criterionResults.filter(result => result.status !== 'pass' && passedEarlier.has(result.criterionId))
}

/**
 * Name the criteria one repair broke, as the failure detail the repair message
 * and the session log carry.
 * @param regressed - the criteria {@link regressedCriteria} found.
 * @returns the detail line, or undefined when the repair broke nothing.
 */
export function regressionDetail(regressed: readonly CriterionResult[]): string | undefined {
  if (regressed.length === 0) return undefined
  return `regression: ${regressed.map(result => result.criterionId).join(', ')} passed before this repair and no longer pass`
}
