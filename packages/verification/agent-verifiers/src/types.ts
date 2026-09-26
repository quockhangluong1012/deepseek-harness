/**
 * Vocabulary for the agent-backed criterion verifiers: the families this
 * package answers with an independent agent, and the browser family's report.
 * Findings-based families reuse the reviewer's own report contract
 * (`ReviewReport` from `@deepseek-ai/dsh-command-review`).
 *
 * @module @deepseek-ai/dsh-agent-verifiers/types
 */

/** One of the `AcceptanceCriterion` families an independent agent decides. */
export type AgentVerifierFamily = 'security' | 'browser' | 'review'

/**
 * The report a `browser` criterion is decided from: whether the scenario the
 * criterion describes held when the reviewer exercised it in a browser.
 */
export interface ScenarioReport {
  /** Whether the scenario held. */
  readonly passed: boolean
  /** What the reviewer did and observed, in one or two sentences. */
  readonly detail: string
  /** Paths, URLs, or tool call ids locating what the reviewer observed. */
  readonly evidence?: readonly string[]
}
