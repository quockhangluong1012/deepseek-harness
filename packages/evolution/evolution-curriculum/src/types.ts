/**
 * Public type vocabulary of the evolution curriculum: the measured capability
 * gap a task is derived from, the proposed task, and the durable proposal
 * record. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-curriculum/src/types
 */

/** One measured capability gap: the failure evidence a task is derived from. */
export interface CurriculumGap {
  /** Capability name (one tracked skill). */
  capability: string
  /** Sessions that reported the failure evidence, newest-first slices. */
  sourceSessions: readonly string[]
  /** Distinct failure gists observed while the capability was in play. */
  failureGists: readonly string[]
}

/** State of one proposed curriculum task. */
export type CurriculumTaskState = 'open' | 'retired'

/** One proposed training/evaluation task, durable in the proposal store. */
export interface CurriculumProposal {
  /** Stable proposal identity. */
  id: string
  /** Capability the task targets. */
  capability: string
  /** Task text, grounded in the failure evidence. */
  task: string
  /** Sessions the evidence was observed in. */
  sourceSessions: readonly string[]
  /** Failure gists the task was derived from, in evidence order. */
  gists: readonly string[]
  /** ISO-8601 instant the proposal was staged. */
  at: string
  /** Whether the proposal is still actionable. */
  state: CurriculumTaskState
}
