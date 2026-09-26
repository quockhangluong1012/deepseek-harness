/**
 * Public type vocabulary of the evolution benchmark store: benchmark states,
 * one durable evaluation task, the input a task is admitted from, and the
 * outcome one executed task records. A task declares the profile and the §5.3
 * scenario family it is authored for and the step horizon it should exercise;
 * an outcome declares what a run of it measured. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-benchmark/src/types
 */

import type { TaskFamily, TaskProfile } from '@deepseek-ai/dsh-evolution-curriculum'
import type { WorkspaceChange, ScenarioRunner } from '@deepseek-ai/dsh-evolution-scorer'
import type { RunOptions, WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'

export type { TaskFamily, TaskProfile }

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
  /** Profile the task is authored for; null when the admitting producer did not classify it. */
  profile: TaskProfile | null
  /** §5.3 scenario family the task belongs to. */
  family: TaskFamily
  /** Minimum steps a run of the task should exercise; null when the producer declared no horizon. */
  stepSpan: number | null
  /** Observable a run's result is judged against; null when the producer shipped none. */
  acceptance: string | null
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
  /**
   * Profile the task is authored for, or null when the producer does not
   * classify it. A producer states this rather than leaving it to the store,
   * because only the producer knows what the task exercises.
   */
  profile: TaskProfile | null
  /**
   * §5.3 scenario family the task belongs to. Every shipped producer derives
   * its tasks from a recorded failure or uncertainty, so it states
   * `loop-recovery`; the §5.3 datasets state the family their file declares.
   */
  family: TaskFamily
  /**
   * Minimum steps a run of the task should exercise, or null when the producer
   * does not bound the horizon.
   */
  stepSpan: number | null
  /**
   * Observable a run's result is judged against, or null when the producer
   * ships none.
   */
  acceptance: string | null
}

/** Whether one executed task produced a verdict or failed before one. */
export type BenchmarkOutcomeStatus = 'scored' | 'failed'

/**
 * One executed benchmark task, as the run pass records it (§13.5). The verdict
 * is the scorer's workspace comparison; every other number is folded from the
 * run's own harvested sessions, so a reader can tell a task that failed from a
 * run that never produced evidence.
 */
export interface BenchmarkOutcome {
  /** Outcome identity. */
  id: string
  /** ISO-8601 instant the run pass recorded the outcome. */
  at: string
  /** The benchmark task the run executed. */
  taskId: string
  /** Capability the task probes; also the scenario name the score carries. */
  capability: string
  /** §5.3 scenario family the task belongs to. */
  family: TaskFamily
  /** Profile the task is authored for; null when the task declared none. */
  profile: TaskProfile | null
  /** Minimum steps the task declares; null when it declares none. */
  stepSpan: number | null
  /** Highest §13.5 horizon tier the declared span reaches; null below the lowest tier. */
  tier: number | null
  /** Whether every attempt's workspace matched the expected observable. */
  pass: boolean
  /** Whether the run produced a verdict or failed before one. */
  status: BenchmarkOutcomeStatus
  /** Why the run produced no verdict; null for a scored run. */
  reason: string | null
  /** Fresh-process attempts the verdict covers; zero for a failed run. */
  attempts: number
  /** Median billed tokens across the attempts. */
  tokens: number
  /** Median wall-clock milliseconds across the attempts. */
  wallTimeMs: number
  /** Every attempt's wall-clock sample, in run order. */
  samples: readonly number[]
  /** Paths where the first divergent attempt differed from the expected observable. */
  changes: readonly WorkspaceChange[]
  /** Model steps the run's first attempt started. */
  steps: number
  /** Verifications the run's first attempt recorded. */
  verifications: number
  /** Verifications of the first attempt that passed. */
  verificationsPassed: number
  /** Tasks the first attempt closed in any terminal status. */
  tasksClosed: number
  /** Tasks the first attempt completed. */
  tasksCompleted: number
  /** Failures the first attempt recorded. */
  failures: number
  /** Failures a recovery decision answered. */
  failuresAnswered: number
  /** Highest prompt-side context occupancy the first attempt's requests reported; null when none did. */
  contextTokens: number | null
  /** Context window the first attempt's requests reported; null when none did. */
  contextWindow: number | null
  /** Recorded session id of the first attempt's primary session, or null when none was harvested. */
  trajectory: string | null
  /** Every harvested session id, parent first. */
  sessionIds: readonly string[]
}

/** One benchmark run pass: which tasks to execute, and how to boot them. */
export interface BenchmarkRunRequest {
  /** Tasks to execute, in run order; the configured cap bounds how many run. */
  tasks: readonly BenchmarkTask[]
  /**
   * Wiring every task's run is booted with — the agent composition, the mode,
   * the fixture, and the workspace the task mutates or analyses. A caller
   * whose tasks need different wiring per task wraps `run` instead.
   */
  options: RunOptions
  /** Fresh-process runner; the seam `evolution-scorer` scores through. */
  run: ScenarioRunner
  /**
   * Expected observable workspace of one task, from
   * `captureExpectedWorkspaceSnapshot`. Each task is judged against its own
   * expectation, because a dataset task declares its acceptance rather than
   * shipping an expected capture; returning undefined scores that task against
   * its own initial workspace, so only a run that changed nothing passes, and
   * omitting the resolver does that for every task.
   */
  expected?: (task: BenchmarkTask) => readonly WorkspaceSnapshotEntry[] | undefined
  /** Attempts per task, overriding the configured default. */
  attempts?: number
}

/** What one benchmark run pass executed. */
export interface BenchmarkRunReport {
  /** One outcome per executed task, in run order. */
  outcomes: readonly BenchmarkOutcome[]
  /** Tasks whose run produced a verdict. */
  scored: number
  /** Executed tasks that passed. */
  passed: number
  /** Tasks whose run failed before a verdict. */
  failed: number
  /** Tasks the configured cap left unexecuted. */
  deferred: number
}
