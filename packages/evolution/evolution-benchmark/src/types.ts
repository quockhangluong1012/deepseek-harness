/**
 * Public type vocabulary of the evolution benchmark store: benchmark states,
 * one durable evaluation task, and the input a task is admitted from. Types
 * only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-benchmark/src/types
 */

/** One benchmark task's contamination/learning state (§35). */
export type BenchmarkState =
  | 'fresh'
  | 'search'
  | 'validation'
  | 'holdout'
  | 'contaminated'
  | 'retired'

/** One durable evaluation task. */
export interface BenchmarkTask {
  /** Stable task identity. */
  id: string
  /** sha256-hex content address deduplicating identical tasks. */
  hash: string
  /** Capability the task probes. */
  capability: string
  /** Task text a run executes or a candidate is judged against. */
  task: string
  /** Failure gists the task was promoted from, in evidence order. */
  gists: readonly string[]
  /** Sessions the evidence was observed in. */
  sourceSessions: readonly string[]
  /** ISO-8601 instant the task was admitted. */
  at: string
  /** Current state. */
  state: BenchmarkState
}

/** One candidate task offered for admission. */
export interface BenchmarkInput {
  /** Capability the task probes. */
  capability: string
  /** Task text a run executes or a candidate is judged against. */
  task: string
  /** Failure gists the task was promoted from, in evidence order. */
  gists: readonly string[]
  /** Sessions the evidence was observed in. */
  sourceSessions: readonly string[]
}
