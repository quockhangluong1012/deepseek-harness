/**
 * Public type vocabulary of the uncertainty-driven learning store: durable
 * uncertainty signals of the five §43 kinds and the prioritized evaluation
 * tasks derived from them. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-uncertainty/src/types
 */

/** One of the five §43 uncertainty-signal kinds, in canonical spec order. */
export type UncertaintyKind =
  | 'disagreement'
  | 'low-confidence'
  | 'instability'
  | 'retrieval-ambiguity'
  | 'conflicting-evidence'

/** One durable uncertainty signal: evidence that a skill or task deserves another look. */
export interface UncertaintySignal {
  /** Signal identity. */
  signalId: string
  /** Skill the signal concerns. */
  skill: string
  /** Task the signal concerns, or null for a skill-wide signal. */
  taskId: string | null
  /** Which §43 uncertainty kind the signal reports. */
  kind: UncertaintyKind
  /** Signal strength, from 0 (weak) to 1 (strong). */
  score: number
  /** Human-readable note saying what was observed. */
  detail: string
  /** ISO-8601 instant the signal was recorded. */
  at: string
}

/** One signal offered for recording. */
export interface UncertaintySignalInput {
  /** Signal identity. */
  signalId: string
  /** Skill the signal concerns. */
  skill: string
  /** Task the signal concerns, or null for a skill-wide signal. */
  taskId: string | null
  /** Which §43 uncertainty kind the signal reports. */
  kind: UncertaintyKind
  /** Signal strength, from 0 (weak) to 1 (strong). */
  score: number
  /** Human-readable note saying what was observed. */
  detail: string
}

/** One prioritized evaluation task derived from grouped signals. */
export interface EvaluationTask {
  /** Skill the task re-evaluates. */
  skill: string
  /** Task to re-evaluate, or null for a skill-wide task. */
  taskId: string | null
  /** Distinct signal kinds behind the task, in canonical §43 order. */
  kinds: UncertaintyKind[]
  /** The strongest signal score behind the task. */
  topScore: number
  /** Queue priority: the top score plus corroboration, capped at 1. */
  priority: number
  /** Number of signals grouped into the task. */
  signals: number
}
