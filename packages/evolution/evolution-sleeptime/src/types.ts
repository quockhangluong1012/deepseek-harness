/**
 * Public type vocabulary of the sleep-time compute store: anticipated future
 * tasks with their likelihood and expected savings, the precomputed reasoning
 * artifacts cached for them, and the economic decision of whether
 * precomputation is worth its offline cost (§25). Types only — no runtime
 * code.
 * @module @deepseek-ai/dsh-evolution-sleeptime/src/types
 */

/** The kinds of reasoning artifact sleep-time compute may precompute. */
export type PrecomputeKind = 'summary' | 'retrieval-index' | 'candidate-plan'

/** One durable anticipated future task. */
export interface AnticipatedTask {
  /** Task identity (the anticipation key). */
  taskId: string
  /** Domain the task is expected in. */
  domain: string
  /** Narrower scope inside the domain, when known. */
  scope?: string | undefined
  /** Probability the task materializes, from 0 to 1. */
  likelihood: number
  /** Expected future queries the task will draw. */
  expectedQueries: number
  /** Expected tokens saved per future query when precomputed. */
  expectedSavingTokens: number
  /** ISO-8601 instant the task was anticipated. */
  at: string
}

/** One task offered for anticipation. */
export interface AnticipationInput {
  /** Task identity (the anticipation key). */
  taskId: string
  /** Domain the task is expected in. */
  domain: string
  /** Narrower scope inside the domain, when known. */
  scope?: string | undefined
  /** Probability the task materializes, from 0 to 1. */
  likelihood: number
  /** Expected future queries the task will draw. */
  expectedQueries: number
  /** Expected tokens saved per future query when precomputed. */
  expectedSavingTokens: number
}

/** One durable precomputed reasoning artifact. */
export interface PrecomputeArtifact {
  /** Artifact identity. */
  artifactId: string
  /** Anticipated task the artifact was precomputed for. */
  taskId: string
  /** The kind of reasoning artifact cached. */
  kind: PrecomputeKind
  /** The precomputed reasoning content. */
  summary: string
  /** Offline tokens spent precomputing the artifact. */
  offlineCostTokens: number
  /** Future queries the artifact has served. */
  hits: number
  /** Tokens the artifact's hits have saved so far. */
  savedTokens: number
  /** ISO-8601 instant the artifact was precomputed. */
  at: string
}

/** One artifact offered for precomputation. */
export interface PrecomputeInput {
  /** Artifact identity. */
  artifactId: string
  /** Anticipated task the artifact was precomputed for. */
  taskId: string
  /** The kind of reasoning artifact cached. */
  kind: PrecomputeKind
  /** The precomputed reasoning content. */
  summary: string
  /** Offline tokens spent precomputing the artifact. */
  offlineCostTokens: number
}

/** The economic decision of whether to precompute one task. */
export interface SleeptimeDecision {
  /** Anticipated task the decision covers. */
  taskId: string
  /** Domain the task is expected in. */
  domain: string
  /** Whether precomputation pays back its offline cost. */
  worthIt: boolean
  /** Expected tokens gained minus the estimated offline cost. */
  expectedNet: number
  /** Why the decision came out this way, naming the numbers. */
  reason: string
}
