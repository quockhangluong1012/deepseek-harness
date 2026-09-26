/**
 * Public type vocabulary of the evolution curriculum: the measured capability
 * gap a task is derived from, the proposed task, the durable proposal record,
 * and the profile/family vocabulary every task and baseline dataset is
 * classified with. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-curriculum/src/types
 */

/**
 * Agent profile a task is authored for (SPEC-2.0 §3, §12.6): the coding,
 * research, mentor, or ICT/analyst loop and output contract the task
 * exercises.
 */
export type TaskProfile = 'coding' | 'research' | 'mentor' | 'ict'

/**
 * Scenario family a task belongs to (§5.3 baseline datasets): coding,
 * research, mentor/ICT analysis, long-horizon execution, or loop/recovery.
 * The family names the dataset, not the agent: the long-horizon and
 * loop/recovery corpora draw tasks from every profile.
 */
export type TaskFamily = 'coding' | 'research' | 'mentor-ict' | 'long-horizon' | 'loop-recovery'

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
  /**
   * §21 "do not do this" statement matched from the gap's evidence, with its
   * trigger condition. Staging always states it — null when nothing matched —
   * so it is optional only on a proposal a caller builds itself.
   */
  antiPattern?: string | null
  /** §21 regression case matched from the gap's evidence, on the same terms as {@link antiPattern}. */
  candidateTest?: string | null
  /** ISO-8601 instant the proposal was staged. */
  at: string
  /** Whether the proposal is still actionable. */
  state: CurriculumTaskState
}
