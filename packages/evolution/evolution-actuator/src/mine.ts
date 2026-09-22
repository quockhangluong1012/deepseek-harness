/**
 * The pure mappings behind §14's benchmark growth: which benchmark task a
 * recorded failure becomes, and what recorded candidate exposure says about
 * one capability. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/mine
 */

import type { BenchmarkInput, ExposureEvidence } from '@deepseek-ai/dsh-evolution-benchmark'
import type { RegressionDebt } from '@deepseek-ai/dsh-evolution-curator'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { PopulationCandidate } from '@deepseek-ai/dsh-evolution-population'

/**
 * One failure's task text, built from the capability and the failure message
 * alone. Observation counts, session counts, and timestamps stay out of it
 * deliberately: the text is the benchmark store's content address, so a
 * failure observed one more time must hash to the task already admitted for it
 * rather than to a second copy. The wording mirrors the curriculum's derived
 * task so an admitted failure reads like every other task in the store.
 * @param capability - the capability the failure was attributed to.
 * @param message - the failing result text.
 * @returns the task text.
 */
function failureTask(capability: string, message: string): string {
  return `Recover from the recurring failure: '${message}' — ${capability} was in play.`
}

/**
 * The benchmark tasks the feedback store's decisive failures become: one per
 * failure it graded `trigger_review`, so a failure reported across
 * `triggerReviewSessions` distinct sessions grows the benchmark (§14's
 * regression promoter). Failures below that grade only rank or observe and
 * produce nothing, and neither does a failure whose tool call was never
 * observed: the store grades such a failure `observe_only`, and without the tool
 * there is no capability to attribute the task to. Sessions stay empty because a
 * graded signal reports how many distinct sessions saw a failure, never which
 * ones, and attributing the failure to every session the caller asked about
 * would invent evidence.
 * @param signals - the graded signals, in any order.
 * @returns the tasks to admit.
 */
export function failureInputs(signals: readonly FeedbackSignal[]): BenchmarkInput[] {
  const inputs: BenchmarkInput[] = []
  for (const signal of signals) {
    const tool = signal.tool
    if (signal.actionability !== 'trigger_review' || tool === null) continue
    inputs.push({
      capability: tool,
      task: failureTask(tool, signal.message),
      gists: [signal.message],
      sourceSessions: [],
    })
  }
  return inputs
}

/**
 * The benchmark tasks the curator's open regression debt becomes: one per
 * failure a skill has not answered, so a debt the curator still owes grows the
 * benchmark as a regression case (§14). Sessions stay empty for the same reason
 * as {@link failureInputs}: the debt records how many sessions reported the
 * failure, not their identities.
 * @param debts - the open debts, in any order.
 * @returns the tasks to admit.
 */
export function debtInputs(debts: readonly RegressionDebt[]): BenchmarkInput[] {
  return debts.map(debt => ({
    capability: debt.name,
    task: failureTask(debt.name, debt.message),
    gists: [debt.message],
    sourceSessions: [],
  }))
}

/**
 * The exposure one capability's recorded candidates give its benchmark tasks:
 * the evaluations that measured a triple, and how many of those passed. An
 * unmeasured candidate is not exposure — it says a candidate existed, not that
 * anything was evaluated — so it counts in neither number.
 * @param candidates - the candidates recorded for one capability.
 * @returns the exposure evidence.
 */
export function exposureOf(candidates: readonly PopulationCandidate[]): ExposureEvidence {
  const triples = candidates.flatMap(candidate => (candidate.triple === null ? [] : [candidate.triple]))
  return { runs: triples.length, passes: triples.filter(triple => triple.pass).length }
}
