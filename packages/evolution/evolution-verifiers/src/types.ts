/**
 * Public type vocabulary of the verifier-first ladder: the level numbering,
 * one judgment a rung reports, the seams a caller mounts, and the verdict the
 * ladder returns. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-verifiers/src/types
 */

/**
 * One rung of the ladder, cheapest first (§12): `0` schema validator, `1`
 * deterministic invariant checks, `2` domain simulator, `3` evaluator model,
 * `4` human review.
 */
export type VerifierLevel = 0 | 1 | 2 | 3 | 4

/** Outcome one rung reports: it decided, it refused, or it could not judge. */
export type VerifierStatus = 'passed' | 'failed' | 'abstained'

/** What one rung decided, with the reason in the rung's own words. */
export interface VerifierJudgment {
  /** Whether the rung passed, failed, or could not judge this candidate. */
  readonly status: VerifierStatus
  /** Why, in one line, phrased for a human reading the verdict. */
  readonly reason: string
}

/** One consulted rung: its level plus the judgment it reported. */
export interface VerifierRungResult extends VerifierJudgment {
  /** The rung that reported this judgment. */
  readonly level: VerifierLevel
}

/**
 * One rung the package cannot run itself, invoked only when every cheaper rung
 * passed. A caller that mounts no seam leaves the rung absent, and the ladder
 * then records that rung as an abstention rather than as a pass.
 */
export type VerifierSeam = () => Promise<VerifierJudgment>

/** One candidate offered to the ladder, plus the seams the caller mounts. */
export interface VerifierRequest {
  /** Skill name the candidate claims to be. */
  readonly name: string
  /** Candidate `SKILL.md` body, frontmatter included. */
  readonly body: string
  /** Level 2: domain simulation or tool execution over the candidate. */
  readonly simulation?: VerifierSeam | undefined
  /** Level 3: an evaluator model's judgment of the candidate. */
  readonly evaluator?: VerifierSeam | undefined
  /** Level 4: a human decision already recorded by the approval path. */
  readonly review?: VerifierSeam | undefined
}

/**
 * The ladder's answer. A failed rung is terminal and names the level that
 * decided; a full pass requires every rung to have passed, so a ladder with an
 * unmounted seam reports an abstention instead of an approval it never earned.
 */
export type VerifierVerdict =
  | {
    /** Skill the verdict judges. */
    readonly name: string
    /** The ladder decided: a rung refused, or every rung passed. */
    readonly status: 'passed' | 'failed'
    /** The rung that decided the verdict. */
    readonly decidedBy: VerifierLevel
    /** The deciding rung's name and reason. */
    readonly reason: string
    /** Every consulted rung, cheapest first, in the order they ran. */
    readonly rungs: readonly VerifierRungResult[]
  }
  | {
    /** Skill the verdict judges. */
    readonly name: string
    /** No rung decided: nothing failed and at least one rung abstained. */
    readonly status: 'abstained'
    /** Always null: an abstention names no deciding level. */
    readonly decidedBy: null
    /** The abstaining rungs, each named with its own reason. */
    readonly reason: string
    /** Every consulted rung, cheapest first, in the order they ran. */
    readonly rungs: readonly VerifierRungResult[]
  }
