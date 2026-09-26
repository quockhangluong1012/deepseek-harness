/**
 * Section validation for profile answers. One pass over an artifact parsed from
 * model or tool JSON reports every contract it broke: the profile it names, the
 * confidence it states, each required section in order, and the basis of every
 * claim against the basis its section accepts.
 * @module @deepseek-ai/dsh-analyst-profiles/validate
 */

import type {
  AnalystProfile,
  ProfileClaim,
  ProfileSection,
  ProfileSectionAnswer,
  ProfileVerdict,
  ProfileViolation,
} from './types.ts'

/** Read one claim from a section entry, or the reason it is unusable.
 * @param value - one entry of a section's `claims` array.
 * @returns The claim, or one sentence naming the missing or invalid member.
 */
function readClaim(value: unknown): ProfileClaim | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('statement' in value) || !('basis' in value)) {
    return 'each claim must be a map with a "statement" and a "basis"'
  }
  if (typeof value.statement !== 'string' || value.statement.trim().length === 0) {
    return 'each claim needs a non-empty "statement" string'
  }
  if (value.basis !== 'observed' && value.basis !== 'inferred') {
    return 'each claim needs a "basis" of "observed" or "inferred"'
  }
  return { statement: value.statement, basis: value.basis }
}

/** Validate one section's claims against the basis that section accepts.
 * @param answer - the answer's section entry.
 * @param section - the contract section it answers.
 * @param position - index of the entry inside the answer's `sections` array.
 * @param violations - collector for every problem found.
 */
function checkClaims(
  answer: ProfileSectionAnswer,
  section: ProfileSection,
  position: number,
  violations: ProfileViolation[],
): void {
  const at = `sections[${String(position)}]`
  if (answer.claims.length === 0) {
    violations.push({ rule: 'empty-section', at, message: `${section.heading} must state at least one claim, even when the answer is that nothing applies` })
    return
  }
  for (const [claimIndex, value] of answer.claims.entries()) {
    const claimAt = `${at}.claims[${String(claimIndex)}]`
    const claim = readClaim(value)
    if (typeof claim === 'string') {
      violations.push({ rule: 'invalid-claim', at: claimAt, message: `${section.heading}: ${claim}` })
      continue
    }
    if (claim.basis !== section.basis) {
      violations.push({
        rule: 'basis-mismatch',
        at: `${claimAt}.basis`,
        message: `${section.heading} accepts only "${section.basis}" claims, and this claim is "${claim.basis}"; move it to a section that accepts that basis or restate it as ${section.basis}`,
      })
    }
  }
}

/** Check every declared section's presence, position, and claims.
 * @param profile - the contract the answer must satisfy.
 * @param answers - the answer's well-formed section entries, in the order it carries them.
 * @param violations - collector for every problem found.
 */
function checkSections(
  profile: AnalystProfile,
  answers: readonly { readonly answer: ProfileSectionAnswer; readonly position: number }[],
  violations: ProfileViolation[],
): void {
  const declared = new Set(profile.sections.map(section => section.heading))
  const seen = new Set<string>()
  for (const { answer, position } of answers) {
    const at = `sections[${String(position)}]`
    if (!declared.has(answer.heading)) {
      violations.push({ rule: 'unexpected-section', at: `${at}.heading`, message: `"${answer.heading}" is not a section of ${profile.id}; the contract declares ${[...declared].join(', ')}` })
      continue
    }
    if (seen.has(answer.heading)) {
      violations.push({ rule: 'duplicate-section', at: `${at}.heading`, message: `${answer.heading} appears more than once` })
      continue
    }
    seen.add(answer.heading)
    const contractPosition = profile.sections.findIndex(section => section.heading === answer.heading)
    if (contractPosition !== position) {
      violations.push({ rule: 'section-order', at, message: `${answer.heading} is section ${String(contractPosition + 1)} of ${profile.id} and the answer carries it at position ${String(position + 1)}` })
    }
  }
  for (const [contractPosition, section] of profile.sections.entries()) {
    const found = answers.find(candidate => candidate.answer.heading === section.heading)
    if (found === undefined) {
      violations.push({ rule: 'missing-section', at: `sections[${String(contractPosition)}]`, message: `${section.heading} is missing; ${profile.id} requires all ${String(profile.sections.length)} sections` })
      continue
    }
    checkClaims(found.answer, section, found.position, violations)
  }
}

/** Validate one produced artifact against a profile's section contract.
 * @param profile - the contract the artifact must satisfy.
 * @param artifact - the parsed answer, from model or tool JSON, so an unknown is expected input.
 * @returns `{ ok: true }`, or every violation the artifact produced.
 */
export function validateProfileArtifact(profile: AnalystProfile, artifact: unknown): ProfileVerdict {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    const kind = artifact === null ? 'null' : Array.isArray(artifact) ? 'an array' : typeof artifact
    return { ok: false, violations: [{ rule: 'not-an-artifact', at: 'artifact', message: `expected a map with "profile", "confidence", and "sections", received ${kind}` }] }
  }
  const violations: ProfileViolation[] = []
  const profileId = 'profile' in artifact ? artifact.profile : undefined
  if (profileId !== profile.id) {
    violations.push({ rule: 'wrong-profile', at: 'profile', message: `the artifact answers as ${JSON.stringify(profileId)} and ${profile.id} was requested` })
  }
  const confidence = 'confidence' in artifact ? artifact.confidence : undefined
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    violations.push({ rule: 'confidence-out-of-range', at: 'confidence', message: `confidence must be a number from 0 to 1, received ${JSON.stringify(confidence)}` })
  }
  const raw = 'sections' in artifact ? artifact.sections : undefined
  if (!Array.isArray(raw)) {
    violations.push({ rule: 'not-an-artifact', at: 'sections', message: `sections must be an array of ${String(profile.sections.length)} section entries, received ${raw === undefined ? 'no array' : typeof raw}` })
    return violations.length === 0 ? { ok: true } : { ok: false, violations }
  }
  const sections: readonly unknown[] = raw
  const answers: { answer: ProfileSectionAnswer; position: number }[] = []
  for (const [position, entry] of sections.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || !('heading' in entry) || typeof entry.heading !== 'string'
      || !('claims' in entry) || !Array.isArray(entry.claims)) {
      violations.push({ rule: 'invalid-section', at: `sections[${String(position)}]`, message: 'each section entry needs a "heading" string and a "claims" array' })
      continue
    }
    answers.push({ answer: { heading: entry.heading, claims: entry.claims }, position })
  }
  if (answers.length === sections.length) checkSections(profile, answers, violations)
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}
