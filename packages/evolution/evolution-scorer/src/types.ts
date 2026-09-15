/**
 * Scoring vocabulary for measured improvement runs: the metric triple a scored
 * scenario reports, the observation one fresh-process attempt supplies, and the
 * corpus plan that feeds the process-level runner.
 * @module @deepseek-ai/dsh-evolution-scorer/types
 */

import type { WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'
import type { AgentUnderTest, InputScript, RunOptions, RunResult } from '@deepseek-ai/dsh-session-snapshot'

/** How one workspace path differs from its expected state. */
export interface WorkspaceChange {
  /** Cwd-relative POSIX path as captured by the snapshot workspace reader. */
  path: string
  /** `added` and `removed` are whole-entry facts; `changed` is same path, different bytes or kind. */
  kind: 'added' | 'removed' | 'changed'
}

/** What one fresh-process attempt observed: workspace state, billed tokens, and wall time. */
export interface ScoreAttempt {
  /** Workspace state the attempt started from, used as the expected state when the scenario ships no `workspace.expected/`. */
  initial: readonly WorkspaceSnapshotEntry[]
  /** Workspace state after the attempt settled. */
  final: readonly WorkspaceSnapshotEntry[]
  /** Billed tokens the token meter measured across this attempt's harvested sessions. */
  tokens: number
  /** Wall-clock milliseconds the attempt took, sampling a fresh process each time. */
  wallTimeMs: number
}

/** Everything the pure scorer needs: the expectation plus every attempt's observation. */
export interface ScoreInput {
  /** Scenario name, carried through to the record. */
  scenario: string
  /** Expected workspace capture; absent for a scenario that ships no `workspace.expected/`. */
  expected?: readonly WorkspaceSnapshotEntry[]
  /** Fresh-process attempts in run order; the score needs at least one. */
  attempts: readonly ScoreAttempt[]
}

/** One scenario's metric triple: pass state, billed tokens, and wall time. */
export interface ScoreRecord {
  /** Scenario name the score belongs to. */
  scenario: string
  /** Whether every attempt's workspace matched its expected state. */
  pass: boolean
  /** Paths where the first divergent attempt differed from its expected workspace; empty when the run passed. */
  changes: readonly WorkspaceChange[]
  /** Median billed tokens across attempts. */
  tokens: number
  /** Median wall-clock milliseconds across attempts. */
  wallTimeMs: number
  /** Every attempt's wall-clock sample in run order, so a reader can see the spread behind the median. */
  samples: readonly number[]
}

/** Result of scoring one scenario. */
export type ScoreOutcome =
  | { status: 'scored'; score: ScoreRecord }
  | { status: 'skipped'; scenario: string; reason: string }

/** One scenario's on-disk inputs, resolved from the corpus without running anything. */
export interface ScenarioPlan {
  /** Scenario directory name inside the corpus. */
  scenario: string
  /** Absolute scenario directory. */
  dir: string
  /** The scenario's ACP input script. */
  script: InputScript
  /** Absolute path of the primary recorded session fixture. */
  fixtureFile: string
  /** Absolute `replay.override.json` sidecar when the scenario ships one. */
  overrideFile?: string
  /** Absolute recorded child-session fixtures, in ordinal order. */
  childFiles: readonly string[]
  /** Absolute `workspace.expected/` directory when the scenario ships one. */
  expectedWorkspaceDir?: string
  /** Absolute `workspace/` seed directory when the scenario starts from seeded files. */
  workspaceDir?: string
}

/** Outcome of reading one scenario from the corpus. */
export type ScenarioPlanResult =
  | { status: 'planned'; plan: ScenarioPlan }
  | { status: 'skipped'; reason: string }

/** One scoring request: which scenario, which agent composition, and how to run it. */
export interface ScoreRequest {
  /** Scenario directory name inside the configured corpus. */
  scenario: string
  /** Agent composition the runner boots; the scorer always runs it in keyless replay mode. */
  agent: AgentUnderTest
  /** Fresh-process runner; {@link processScenarioRunner} and the snapshot harness's `runScenario` satisfy it. */
  run: ScenarioRunner
}

/** Fresh-process scenario runner: `runScenario` from `@deepseek-ai/dsh-session-snapshot` satisfies it. */
export type ScenarioRunner = (input: InputScript, options: RunOptions) => Promise<RunResult>

/** Thresholds the optimization trigger reads to decide whether a record speaks. */
export interface TriggerThresholds {
  /** Recorded loads required before a failure rate counts. */
  minUses: number
  /** Failure share a record must exceed, in 0..1. */
  failureRate: number
}

/** One skill evaluation: which skill, over which corpus scenarios, and how to run them. */
export interface EvaluateSkillRequest {
  /** Skill the scenarios exercise. */
  skill: string
  /** Scenario directory names inside the configured corpus, in run order. */
  scenarios: readonly string[]
  /** Agent composition the runner boots; the scorer always runs it in keyless replay mode. */
  agent: AgentUnderTest
  /** Fresh-process runner; {@link processScenarioRunner} and the snapshot harness's `runScenario` satisfy it. */
  run: ScenarioRunner
}

/** One skill's aggregated metric triple: the Pareto input an optimizer selects on. */
export interface SkillScore {
  /** Skill the triple belongs to. */
  skill: string
  /** Whether every scenario's workspace matched its expected state. */
  pass: boolean
  /** Billed tokens summed over the scenarios' medians. */
  tokens: number
  /** Wall-clock milliseconds summed over the scenarios' medians. */
  wallTimeMs: number
  /** Per-scenario records in run order. */
  scores: readonly ScoreRecord[]
}

/** Result of evaluating one skill. */
export type SkillEvaluation =
  | { status: 'evaluated'; score: SkillScore }
  | { status: 'skipped'; skill: string; reason: string }
