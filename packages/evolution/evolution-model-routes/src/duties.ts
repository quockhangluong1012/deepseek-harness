/**
 * §53's separation of duties over the evolutionary role topology: the identity
 * that generated a candidate must not be the identity that judges it — the
 * `promotion-review` identity for a promotion, the `evaluation` identity for a
 * verdict. Pure: no I/O, no domain, no model call.
 * @module @deepseek-ai/dsh-evolution-model-routes/src/duties
 */

import type { DutyDecision, DutyRecord, DutyVerdict, EvolutionRole } from './types.ts'

/** The role pair one guarded decision separates. */
export interface DutySeparation {
  /** The role that generated the candidate under judgement. */
  producing: EvolutionRole
  /** The role whose identity must differ from the producer's. */
  judging: EvolutionRole
}

/**
 * The role pair each guarded decision separates: both decisions judge a
 * candidate that candidate generation produced, promotion review judging a
 * promotion and evaluation judging a verdict.
 */
export const SEPARATED_DUTIES: Record<DutyDecision, DutySeparation> = {
  promotion: { producing: 'candidate-generation', judging: 'promotion-review' },
  verdict: { producing: 'candidate-generation', judging: 'evaluation' },
}

/**
 * The storage key of one recorded duty: run and role joined with a separator no
 * role contains. Roles carry no separator, so the key stays injective per
 * (run, role) pair, and both halves are path-safe for the per-record layout.
 * @param runId - the run the duty belongs to.
 * @param role - the role the identity filled.
 * @returns the duty key.
 */
export function dutyKey(runId: string, role: EvolutionRole): string {
  return `${runId}_${role}`
}

/**
 * The identity one run recorded for one role. A missing row and an empty
 * identity both read as unrecorded: the check fails closed rather than reading
 * an absent record as a distinct identity.
 * @param duties - every recorded duty.
 * @param runId - the run to read.
 * @param role - the role to read.
 * @returns the recorded identity, or undefined when the run records none.
 */
function recordedIdentity(
  duties: readonly DutyRecord[],
  runId: string,
  role: EvolutionRole,
): string | undefined {
  const identity = duties.find(duty => duty.runId === runId && duty.role === role)?.identity
  return identity === undefined || identity === '' ? undefined : identity
}

/**
 * §53's separation of duties for one decision over one run: the judging role
 * must be filled by an identity other than the one that filled the producing
 * role. Refuses as `unknown-identity` when either role carries no recorded
 * identity — an unrecorded role is never assumed distinct — and as
 * `same-identity` when one identity filled both.
 * @param duties - every recorded duty.
 * @param runId - the run the decision concerns.
 * @param decision - the decision being taken.
 * @returns the verdict; a refusal carries the reason naming both roles.
 */
export function separationOfDuties(
  duties: readonly DutyRecord[],
  runId: string,
  decision: DutyDecision,
): DutyVerdict {
  const pair = SEPARATED_DUTIES[decision]
  const producing = recordedIdentity(duties, runId, pair.producing)
  const judging = recordedIdentity(duties, runId, pair.judging)
  if (producing === undefined || judging === undefined) {
    const missing = producing === undefined ? pair.producing : pair.judging
    return {
      allowed: false,
      refusal: 'unknown-identity',
      reason: `run '${runId}' records no ${missing} identity, so ${pair.producing} and ${pair.judging} cannot be shown to be separate identities`,
    }
  }
  if (producing === judging) {
    return {
      allowed: false,
      refusal: 'same-identity',
      reason: `identity '${producing}' filled both ${pair.producing} and ${pair.judging} for run '${runId}'`,
    }
  }
  return { allowed: true }
}
