/**
 * The pure rollout decision behind the canary monitor: what one live
 * deployment's recorded evidence says §18's ladder should do next. No I/O.
 * @module @deepseek-ai/dsh-evolution-actuator/src/rollout
 */

import type { DeploymentRecord, RiskInput, RiskRoute } from '@deepseek-ai/dsh-evolution-canary'
import type { RolloutDecision } from './types.ts'

/**
 * Decide one live rollout from the candidate's measured triple and the
 * incumbent's. A patch that failed its corpus never promotes. A passing patch
 * promotes unless it costs more than the incumbent on the engine's own elite
 * order — more billed tokens, or equal tokens and more wall time — by
 * `costFactor`. With no measured incumbent only the candidate's own result
 * decides, because a first rollout has no baseline to regress against. A
 * deployment whose triple was never measured holds: there is no evidence to
 * promote or roll back on.
 * @param candidate - the live deployment's record.
 * @param incumbent - the newest promoted deployment of the same skill, if any.
 * @param costFactor - cost multiple over the incumbent that fails a rollout.
 * @returns the decision.
 */
export function rolloutDecision(
  candidate: DeploymentRecord,
  incumbent: DeploymentRecord | undefined,
  costFactor: number,
): RolloutDecision {
  const measured = candidate.triple
  if (measured === null) return 'hold'
  if (!measured.pass) return 'rollback'
  const baseline = incumbent?.triple
  if (baseline === null || baseline === undefined) return 'promote'
  if (measured.tokens > baseline.tokens * costFactor) return 'rollback'
  if (measured.tokens === baseline.tokens && measured.wallTimeMs > baseline.wallTimeMs * costFactor) {
    return 'rollback'
  }
  return 'promote'
}

/**
 * What §49's risk model is told about one live rollout. The artifact is a skill
 * patch because the canary store tracks only staged skill writes. The evidence is
 * the record's measured triple: `none` when the patch was never measured,
 * `strong` when it was, because the cost comparison against the incumbent's
 * triple is the decision's own check rather than a grade of the evidence. The
 * change is reversible because the deployment is still staged: the monitor
 * decides a `canary` rollout, and `canary` can still exit to `rolled-back`, so a
 * wrong bet leaves the ladder rather than sticking.
 * @param candidate - the live deployment's record.
 * @param holdout - whether a protected holdout covers the deployment's capability.
 * @returns the risk input.
 */
export function rolloutRisk(candidate: DeploymentRecord, holdout: boolean): RiskInput {
  return {
    artifact: 'skill',
    evidence: candidate.triple === null ? 'none' : 'strong',
    reversible: true,
    holdout,
  }
}

/**
 * Whether §49's route licenses the monitor to end a live rollout with a
 * decision. A measured regression always leaves the ladder: rolling back
 * restores the incumbent rather than installing the patch, so it is not the step
 * the risk model guards. A promotion needs the `auto-promote` route; every
 * other route — `canary` for a medium-risk patch, `human-approval` or
 * `human-review` for a high or undecidable one — keeps the deployment live for
 * the operator step it names.
 * @param decision - the decision the recorded evidence yields, `promote` or `rollback`.
 * @param route - the route the risk model returned for the rollout.
 * @returns whether the monitor may perform the decision.
 */
export function routeAllows(decision: Exclude<RolloutDecision, 'hold'>, route: RiskRoute): boolean {
  return decision === 'rollback' || route === 'auto-promote'
}
