/**
 * Public type vocabulary of the canary deployment store: the rollout states of
 * one staged skill patch and its measured shadow evidence. Types only — no
 * runtime code.
 * @module @deepseek-ai/dsh-evolution-canary/src/types
 */

/**
 * One deployment stage on the §18 rollout ladder: a patch enters as `shadow`
 * (hidden beside the baseline), advances to `canary` on a live fraction, and
 * `promoted` once it is trusted; either staged rollout can exit to `rejected`
 * or `rolled-back`, and terminal states never leave.
 */
export type DeploymentState = 'shadow' | 'canary' | 'promoted' | 'rolled-back' | 'rejected'

/** The measured triple of a staged patch in shadow. */
export interface DeploymentTriple {
  /** Whether the patch passed its corpus. */
  pass: boolean
  /** Billed tokens the patch consumed. */
  tokens: number
  /** Wall time of the patch's attempts, in milliseconds. */
  wallTimeMs: number
}

/** One durable deployment record. */
export interface DeploymentRecord {
  /** Staged-write identity the deployment tracks. */
  id: string
  /** Skill the patch mutates. */
  skill: string
  /** Current rollout stage. */
  state: DeploymentState
  /** The patch's measured shadow triple, or null when unmeasured. */
  triple: DeploymentTriple | null
  /** ISO-8601 instant the record was last changed. */
  at: string
  /** ISO-8601 instant the deployment entered shadow. */
  enteredAt: string
  /** ISO-8601 instant a terminal decision was recorded, or null while rolling out. */
  decidedAt: string | null
}

/** One deployment offered for recording. */
export interface DeploymentInput {
  /** Staged-write identity the deployment tracks. */
  id: string
  /** Skill the patch mutates. */
  skill: string
  /** The patch's measured shadow triple, or null when unmeasured. */
  triple: DeploymentTriple | null
}
