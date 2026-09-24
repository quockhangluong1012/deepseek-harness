/**
 * Skill admission: whether one skill may be advertised to and loaded by a model
 * in this deployment, and whether the capabilities it declares stay inside the
 * authority its caller already holds.
 *
 * Admission is a gate over metadata, never a grant. A skill may narrow the
 * capabilities a task uses; it can never widen them, and nothing here allows a
 * capability the permission document did not already allow.
 *
 * @module @deepseek-ai/dsh-skill/admission
 */

import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'

/** How a skill entered the deployment. */
export type SkillAdmission = 'bundled' | 'project-reviewed' | 'user-approved' | 'quarantined'

/** Everything the admission gate reads. */
export interface SkillAdmissionRequest {
  /**
   * The skill's admission claim. Absent means the provider made none, which
   * leaves the decision to it — the shipped providers filter at discovery.
   */
  readonly admission?: SkillAdmission | undefined
  /** How far the skill body may be trusted. */
  readonly trust?: TrustLabel | undefined
  /** Capability names the skill declares. */
  readonly capabilities?: readonly string[] | undefined
  /**
   * Capabilities the caller already holds. Absent means the caller states no
   * ceiling, so containment is not checked.
   */
  readonly granted?: readonly string[] | undefined
}

/** Why a skill was admitted or refused. */
export interface SkillAdmissionVerdict {
  /** Whether the skill may be advertised and loaded. */
  readonly admitted: boolean
  /** Every reason behind the verdict, in evaluation order. */
  readonly reasons: readonly string[]
}

/**
 * Whether every capability a skill declares is inside the caller's grant.
 * @param declared - capability names the skill declares.
 * @param granted - capabilities the caller holds; undefined states no ceiling.
 * @returns true when the declaration stays inside the grant.
 */
export function capabilitiesWithin(
  declared: readonly string[] | undefined,
  granted: readonly string[] | undefined,
): boolean {
  if (declared === undefined || granted === undefined) return true
  return declared.every(capability => granted.includes(capability))
}

/**
 * Decide whether one skill may be used with the authority its caller holds.
 *
 * A provider-quarantined skill is refused outright. An untrusted skill is
 * refused unless its provider names the review that admitted it, because
 * project and repository content stays data until something admitted it. A
 * declared capability outside the caller's grant is refused: narrowing is
 * allowed, widening is not.
 * @param request - the skill's admission claim, trust, declared capabilities, and the caller's grant.
 * @returns the verdict and every reason behind it.
 */
export function admitSkill(request: SkillAdmissionRequest): SkillAdmissionVerdict {
  const reasons: string[] = []
  if (request.admission === 'quarantined') {
    reasons.push('the provider quarantined this skill')
  } else if (request.trust === 'untrusted' && request.admission === undefined) {
    reasons.push('an untrusted skill needs an explicit admission (bundled, project-reviewed, or user-approved)')
  }
  const declared = request.capabilities ?? []
  const granted = request.granted
  if (granted !== undefined) {
    for (const capability of declared) {
      if (!granted.includes(capability)) {
        reasons.push(`capability "${capability}" is outside the authority this caller holds`)
      }
    }
  }
  return { admitted: reasons.length === 0, reasons }
}
