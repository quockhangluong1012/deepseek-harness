/**
 * Public type vocabulary of the evaluator-health store: one recorded verdict,
 * the per-channel health row, and the summary. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-evaluator-health/src/types
 */

/** Verdict kinds the store records; a skipped evaluation records nothing. */
export type EvaluatorRunStatus = 'gated' | 'evaluated'

/** One recorded behavior-evaluation verdict. */
export interface EvaluatorRun {
  /** Stable verdict identity. */
  id: string
  /** Skill the evaluation judged. */
  skill: string
  /** Whether the gates spoke with one voice. */
  unanimous: boolean
  /** Verdict kind. */
  status: EvaluatorRunStatus
  /** Whether the evaluation approved; false for a gated run. */
  approved: boolean
  /** Channels that approved, in canonical order. */
  approving: readonly string[]
  /** Channels that dissented, in canonical order. */
  dissenting: readonly string[]
  /**
   * The later ground-truth judgment of this verdict, or null while unjudged;
   * absent on verdicts recorded before judgments were possible, which reads as
   * unjudged.
   */
  judgment?: RunJudgment | null | undefined
  /** ISO-8601 instant the verdict was recorded. */
  at: string
}

/** A ground truth that judged one recorded verdict after the fact (§13). */
export interface RunJudgment {
  /** Whether the ground truth agreed with the evaluator's verdict. */
  agrees: boolean
  /** Whether the ground truth was measured independently of the evaluator. */
  independent: boolean
  /** ISO-8601 instant the judgment was recorded. */
  at: string
}

/** One later judgment offered for recording. */
export interface RunJudgmentInput {
  /** Whether the ground truth agreed with the evaluator's verdict. */
  agrees: boolean
  /** Whether the ground truth was measured independently of the evaluator. */
  independent: boolean
}

/** One verdict offered for recording; skipped evaluations carry no judgment and are rejected. */
export interface EvaluatorRunInput {
  /** Skill the evaluation judged. */
  skill: string
  /** Whether the gates spoke with one voice. */
  unanimous: boolean
  /** Verdict kind the evaluation produced; `skipped` rejects. */
  status: EvaluatorRunStatus | 'skipped'
  /** Whether the evaluation approved. */
  approved: boolean
  /** Channels that approved. */
  approving: readonly string[]
  /** Channels that dissented. */
  dissenting: readonly string[]
}

/** One channel's aggregated health. */
export interface ChannelHealthRow {
  /** Channel name. */
  channel: string
  /** Verdicts the channel participated in. */
  runs: number
  /** Verdicts where the channel approved. */
  approved: number
  /** Approval share of the channel's verdicts, in 0..1. */
  approvalRate: number
}

/** Aggregated evaluator-health facts. */
export interface EvaluatorHealthSummary {
  /** Verdicts recorded. */
  runs: number
  /** Share of verdicts the gates decided unanimously, in 0..1. */
  unanimousRate: number
  /** Share of verdicts approved, in 0..1. */
  approvalRate: number
  /** Approval share of the newest `window` verdicts, in 0..1. */
  recentApprovalRate: number
  /** Recent minus overall approval share: positive means approvals rising. */
  drift: number
  /** Approved verdicts later contradicted by a same-skill rejection, as a share of approvals. */
  falsePositiveRate: number
  /** Per-channel rows. */
  channels: readonly ChannelHealthRow[]
}

/**
 * The calibration face of evaluator health (§13): the negative half of the
 * contradiction reading, and how the evaluator correlates with the ground
 * truths that later judged it. `falsePositiveRate` on the summary is the
 * positive half of the same reading.
 */
export interface JudgeCalibration {
  /** Rejected verdicts later contradicted by a newer same-skill approval, as a share of rejections. */
  falseNegativeRate: number
  /** Verdicts a later independent ground truth judged. */
  independentlyJudged: number
  /** Share of those judgments that agreed with the verdict, in 0..1; 0 with none. */
  agreementRate: number
}
