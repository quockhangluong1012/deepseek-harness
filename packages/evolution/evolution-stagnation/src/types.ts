/**
 * Public type vocabulary of the stagnation-detection store: one evaluation
 * run with its measured triple, its improvement flag, and the derived status
 * that names the next strategy when a skill's frontier stalls (§32). Types
 * only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-stagnation/src/types
 */

/** The measured triple of one evaluation run. */
export interface RunScore {
  /** Whether the run passed its corpus. */
  pass: boolean
  /** Billed tokens the run consumed. */
  tokens: number
  /** Median wall time of the run's attempts, in milliseconds. */
  wallTimeMs: number
}

/** One durable evaluation run. */
export interface StagnationRun {
  /** Run identity (the staged write id). */
  runId: string
  /** Skill the run evaluated. */
  skill: string
  /** Generation tick of the skill this run belongs to, starting at 1. */
  generation: number
  /** The run's measured triple. */
  score: RunScore
  /** Whether the run meaningfully improved the skill's best score. */
  improved: boolean
  /** ISO-8601 instant the run was recorded. */
  at: string
}

/** One run offered for recording. */
export interface StagnationRunInput {
  /** Run identity (the staged write id). */
  runId: string
  /** Skill the run evaluated. */
  skill: string
  /** The run's measured triple. */
  score: RunScore
}

/** The strategy the stagnation detector currently recommends. */
export type StagnationStrategy =
  | 'exploitation'
  | 'diversity'
  | 'newOperators'
  | 'newTasks'
  | 'newEvaluators'
  | 'newModel'

/** The derived stagnation status of one skill. */
export interface StagnationStatus {
  /** Skill the status describes. */
  skill: string
  /** Number of recorded runs for the skill. */
  runs: number
  /** The skill's best score so far, or null with no runs. */
  bestScore: RunScore | null
  /** Runs counted since the last meaningful improvement. */
  generationsSinceImprovement: number
  /** Whether the skill has stalled past the configured threshold. */
  stagnant: boolean
  /** The configured stagnation threshold, in runs. */
  threshold: number
  /** The strategy the skill should follow now. */
  strategy: StagnationStrategy
}
