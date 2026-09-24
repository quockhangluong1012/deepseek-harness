/**
 * Scoring vocabulary for measured improvement runs: the metric triple a scored
 * scenario reports, the observation one fresh-process attempt supplies, and the
 * corpus plan that feeds the process-level runner.
 * @module @deepseek-ai/dsh-evolution-scorer/types
 */

import type { WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'
import type { AgentUnderTest, InputScript, RunOptions, RunResult } from '@deepseek-ai/dsh-session-snapshot'
import type { SkillRankSignal, SkillRankVectors } from '@deepseek-ai/dsh-skill'

export type { SkillRankSignal, SkillRankVectors }

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
  /** Recorded id of the attempt's primary harvested session, or undefined when none was harvested. */
  sessionId?: string | undefined
}

/** Everything the pure scorer needs: the expectation plus every attempt's observation. */
export interface ScoreInput {
  /** Scenario name, carried through to the record. */
  scenario: string
  /** Expected workspace capture; absent for a scenario that ships no `workspace.expected/`. */
  expected?: readonly WorkspaceSnapshotEntry[]
  /** Fresh-process attempts in run order; the score needs at least one. */
  attempts: readonly ScoreAttempt[]
  /** Content digest of the recorded fixture(s) this scenario ran against, carried through to the record. */
  fixtureDigest: string
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
  /** Content digest of the recorded fixture(s) this scenario ran against — names which corpus generation validated this score. */
  fixtureDigest: string
  /** Recorded session id of the first attempt's primary harvested session, or null when none was harvested. */
  trajectory: string | null
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
  /**
   * Fresh-process attempts this score buys, overriding the scorer's configured
   * default (S9 tier gate: 1 for a body a corpus fixture already validates, the
   * configured default for a candidate that changed it).
   */
  attempts?: number
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
  /** Fresh-process attempts each scenario buys; see {@link ScoreRequest.attempts}. */
  attempts?: number
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

/** One skill revision under behavior evaluation. */
export interface BehaviorRevision {
  /** Skill name the body must keep in its frontmatter. */
  readonly name: string
  /** Complete replacement SKILL.md body, frontmatter included. */
  readonly body: string
}

/** One routing-catalog entry: the candidate among its distractors. */
export interface BehaviorCatalogSkill {
  /** Skill name for rank lookup. */
  readonly name: string
  /** Routing text: name, description, and when-to-use joined by the caller. */
  readonly text: string
  /** Content key; bumps on every revision so a report never mixes revisions. */
  readonly revisionKey: string
  /** Downstream utility evidence; omission ranks on lexical fit alone. */
  readonly signal?: SkillRankSignal | undefined
  /** Prerequisite skill names from frontmatter `requires`; omission declares none. */
  readonly requires?: readonly string[] | undefined
  /**
   * Capability names this skill provides, from frontmatter `capabilities`.
   * They feed the selector's prerequisite gate: a prerequisite named by
   * `requires` is met when any catalog entry provides it as a capability, so
   * a candidate can route on a capability rather than a sibling skill name.
   */
  readonly capabilities?: readonly string[] | undefined
  /**
   * Rival skill names this skill must not be selected alongside, from
   * frontmatter `conflicts_with`. They feed the selector's conflict gate:
   * of a conflicting pair only the better ranked keeps its score, so the
   * other never passes a positive query.
   */
  readonly conflictsWith?: readonly string[] | undefined
}

/** Behavior evaluation request: two replay compositions plus routing queries. */
export interface BehaviorEvalRequest {
  /** Replay composition running the baseline revision. */
  readonly baseline: EvaluateSkillRequest
  /** Replay composition running the candidate revision. */
  readonly candidate: EvaluateSkillRequest
  /** Candidate revision the contract gate reads. */
  readonly candidateBody: BehaviorRevision
  /** Routing catalog holding the candidate among distractors. */
  readonly catalog: readonly BehaviorCatalogSkill[]
  /** Trigger queries that must route to the candidate. */
  readonly positiveQueries: readonly string[]
  /** Trigger queries that must not route to the candidate. */
  readonly negativeQueries: readonly string[]
  /** Routing window for both query sets; 1 means top rank only. */
  readonly routingTopK?: number | undefined
  /** Embedding vectors for the routing selector; omission ranks without semantics. */
  readonly vectors?: SkillRankVectors | undefined
}

/** One trigger query's routing verdict. */
export interface BehaviorRoutingCheck {
  /** The trigger query. */
  readonly query: string
  /** Whether the query must route to the candidate or avoid it. */
  readonly expected: 'route' | 'avoid'
  /**
   * 1-based rank of the candidate among the candidates the selector scores
   * at all; a candidate it scores zero is not selectable and ranks after them.
   */
  readonly rank: number
  /** Whether the rank satisfies the expectation. */
  readonly ok: boolean
}

/** Routing gate: the candidate must route on positives and avoid negatives. */
export interface BehaviorRoutingGate {
  /** Whether every check passed. */
  readonly ok: boolean
  /** Per-query verdicts in caller order. */
  readonly checks: readonly BehaviorRoutingCheck[]
  /** Catalog revisions the ranks were computed over, in catalog order. */
  readonly revisions: readonly { readonly name: string; readonly revisionKey: string }[]
}

/** Contract gate: the candidate body must be committable. */
export interface BehaviorContractGate {
  /** Whether the body passed. */
  readonly ok: boolean
  /** Why the body cannot be committed, empty when it passed. */
  readonly issues: readonly string[]
}

/** Evaluating channel in a behavior evaluation, cheapest first. */
export type DisagreementChannel = 'contract' | 'routing' | 'replay'

/** One channel's verdict on the candidate. */
export interface ChannelVerdict {
  /** Which channel judged. */
  readonly channel: DisagreementChannel
  /** Whether the channel approved the candidate. */
  readonly ok: boolean
}

/**
 * What the evaluating channels said about one candidate: the approving and
 * dissenting channels in canonical order, and whether they speak with one
 * voice. Unanimous covers both agreement to approve and agreement to
 * reject — a split is the uncertainty signal, not the rejection itself.
 */
export interface EvaluatorDisagreement {
  /** True when every reporting channel approved or every one dissented. */
  readonly unanimous: boolean
  /** Channels that approved, in canonical order. */
  readonly approving: readonly DisagreementChannel[]
  /** Channels that dissented, in canonical order. */
  readonly dissenting: readonly DisagreementChannel[]
}

/** Replay gate: baseline-vs-candidate over the same scenarios. */
export interface BehaviorReplayGate {
  /** Whether the candidate regressed nothing the baseline proved. */
  readonly ok: boolean
  /** Baseline triple. */
  readonly baseline: SkillScore
  /** Candidate triple. */
  readonly candidate: SkillScore
  /** Scenarios the baseline passed that the candidate failed. */
  readonly regressions: readonly string[]
  /** Candidate minus baseline billed tokens, summed over scenario medians. */
  readonly tokenDelta: number
}

/** Result of one behavior evaluation. */
export type BehaviorEvaluation =
  | {
    /** Every gate ran; approval needs all three. */
    status: 'evaluated'
    /** Skill under test. */
    skill: string
    /** Frontmatter gate. */
    contract: BehaviorContractGate
    /** Trigger-query gate. */
    routing: BehaviorRoutingGate
    /** Baseline-vs-candidate replay gate. */
    replay: BehaviorReplayGate
    /** What the three channels said: unanimity or the dissenting channel. */
    disagreement: EvaluatorDisagreement
    /** True only when every gate passed: only replay evidence approves. */
    approved: boolean
  }
  | {
    /** A cheap gate failed, so the process-expensive replay never ran. */
    status: 'gated'
    /** Skill under test. */
    skill: string
    /** Frontmatter gate. */
    contract: BehaviorContractGate
    /** Trigger-query gate. */
    routing: BehaviorRoutingGate
    /** What the two cheap gates said; replay did not run. */
    disagreement: EvaluatorDisagreement
    /** Which cheap gate stopped the evaluation. */
    reason: string
  }
  | { status: 'skipped'; skill: string; reason: string }
