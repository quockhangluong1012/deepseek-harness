/**
 * Answer-contract vocabulary shared by the analyst profiles, the preset rows
 * that install them, and the consumers that validate a produced answer.
 * @module @deepseek-ai/dsh-analyst-profiles/types
 */

/** How one claim is grounded. */
export type ClaimBasis = 'observed' | 'inferred'

/** One required section of a profile's answer. */
export interface ProfileSection {
  /** Heading the answer carries verbatim, positioned by its index in {@link AnalystProfile.sections}. */
  readonly heading: string
  /**
   * Basis every claim under this heading must carry: `observed` claims read the
   * supplied inputs, `inferred` claims read those observations. A heading whose
   * claims disagree with it mixes observation and interpretation, which
   * {@link validateProfileArtifact} rejects.
   */
  readonly basis: ClaimBasis
  /** What belongs in this section, as the model-facing instruction for it. */
  readonly guidance: string
}

/** One analyst answer contract. */
export interface AnalystProfile {
  /** Stable id, which is also the artifact's `profile` value and the preset's identity. */
  readonly id: string
  /** Display name the preset publishes. */
  readonly title: string
  /** One sentence on what the profile answers. */
  readonly description: string
  /** Method paragraph the profile's prompt opens with, before the shared answer rules. */
  readonly method: string
  /** Required sections, in the order the answer carries them. */
  readonly sections: readonly ProfileSection[]
}

/** One claim in an answer. */
export interface ProfileClaim {
  /** The claim text. */
  readonly statement: string
  /** How the claim is grounded. */
  readonly basis: ClaimBasis
}

/** One section's claims as an answer carries them. */
export interface ProfileSectionAnswer {
  /** Heading, which must equal the contract heading at the same position. */
  readonly heading: string
  /** Claims under that heading; at least one. */
  readonly claims: readonly ProfileClaim[]
}

/** The structured answer one analyst profile produces. */
export interface ProfileArtifact {
  /** The profile the answer was produced as. */
  readonly profile: string
  /**
   * Overall confidence from 0 to 1, where 0.5 means no edge either way; the
   * confidence section states what justifies the value.
   */
  readonly confidence: number
  /** One entry per required section, in profile order. */
  readonly sections: readonly ProfileSectionAnswer[]
}

/** Rule that rejected an artifact. */
export type ProfileViolationRule =
  | 'not-an-artifact'
  | 'wrong-profile'
  | 'confidence-out-of-range'
  | 'missing-section'
  | 'unexpected-section'
  | 'duplicate-section'
  | 'section-order'
  | 'invalid-section'
  | 'empty-section'
  | 'invalid-claim'
  | 'basis-mismatch'

/** One reason an artifact does not satisfy a profile. */
export interface ProfileViolation {
  /** Rule the artifact broke, for callers that route on the failure. */
  readonly rule: ProfileViolationRule
  /** Location inside the artifact, such as `sections[3].claims[1].basis`. */
  readonly at: string
  /** One line naming what to change in the answer. */
  readonly message: string
}

/**
 * Result of validating one artifact against one profile: `ok` when every
 * required section is present in order with correctly based claims, otherwise
 * every violation found in the single pass.
 */
export type ProfileVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly ProfileViolation[] }
