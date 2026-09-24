/**
 * Public type vocabulary of the evolution curator: run options, transitions,
 * and the preview report. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-curator/src/types
 */

import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { VerifierLevel } from '@deepseek-ai/dsh-evolution-verifiers'
import type { SkillLifecycleState, SkillTrustFailure, SkillTrustState } from '@deepseek-ai/dsh-evolution-skill-telemetry'

export type { SkillLifecycleState }

/** Options for one curator pass. */
export interface CuratorRunOptions {
  /** Epoch milliseconds the pass reasons about; defaults to the real clock. */
  now?: number | undefined
  /** Preview without writing when true. */
  dryRun?: boolean | undefined
}

/** Options for the idle-gated entry point. */
export interface CuratorMaybeRunOptions extends CuratorRunOptions {
  /** Milliseconds since last observed user activity; defaults to the observed host idleness. */
  idleMs?: number | undefined
}

/** One automatic lifecycle movement applied or previewed by a pass. */
export interface CuratorTransition {
  /** Skill name. */
  name: string
  /** Lifecycle state before the pass. */
  from: SkillLifecycleState
  /** Lifecycle state after the pass. */
  to: SkillLifecycleState
  /** Idle age and the threshold it crossed. */
  reason: string
}

/** Outcome of one curator pass, written or previewed. */
export interface CuratorReport {
  /** ISO-8601 instant the pass ran. */
  at: string
  /** Whether the pass previewed without writing. */
  dryRun: boolean
  /** Tracked skills examined. */
  scanned: number
  /** Movements applied, or previewed under `dryRun`. */
  transitions: CuratorTransition[]
  /** Examined skills skipped for pinning. */
  skippedPinned: number
  /** Examined skills skipped as protected names. */
  skippedProtected: number
  /** Examined skills skipped as bundled or hub sources. */
  skippedExcluded: number
  /** Pass identity when a snapshot was written, or null. */
  passId: string | null
  /** Snapshot tarball filename when a snapshot was written, or null. */
  snapshot: string | null
  /** Consolidation outcome when the LLM pass is opted in and ran; otherwise undefined. */
  consolidation?: ConsolidationReport | undefined
  /** Skills this pass staged for review, worst failure rate first. */
  staged: StagedCandidate[]
  /** Failures still open after this pass, worst first: the regression debt. */
  regressionDebt: RegressionDebt[]
}

/** One failure a skill has not answered: open regression debt. */
export interface RegressionDebt {
  /** Skill carrying the failure. */
  name: string
  /** Tool-and-message identity the failure merges under. */
  mergeKey: string
  /** Failing result text, as last observed. */
  message: string
  /** ISO-8601 instant of the pass that opened the debt. */
  firstSeenAt: string
  /** ISO-8601 instant of the most recent pass that still saw it. */
  lastSeenAt: string
  /** Consecutive passes that saw the failure open, starting at 1. */
  passes: number
  /** Distinct sessions reporting the failure at the last sighting. */
  sessions: number
  /** Skill body revision the debt was opened against; a newer revision closes it. */
  revision: number
}

/** Clock override for rollback calls. */
export interface RollbackOptions {
  /** Epoch milliseconds the rollback reasons about; defaults to the real clock. */
  now?: number | undefined
}

/** One skill restored by a rollback. */
export interface RollbackRestored {
  /** Skill name. */
  name: string
  /** Lifecycle state before the rollback. */
  from: SkillLifecycleState
  /** Lifecycle state after the rollback. */
  to: SkillLifecycleState
}

/** Outcome of one whole-run or single-entry rollback. */
export interface RollbackReport {
  /** ISO-8601 instant the rollback ran. */
  at: string
  /** Human label of the rolled-back unit, such as `pass '<id>'`. */
  label: string
  /** Skills restored, in ledger order. */
  restored: RollbackRestored[]
  /** Pre-rollback record snapshot identity, making the rollback reversible. */
  preRollback: string
  /** Skills whose relocated package directories moved back, in ledger order. */
  restoredDirs: string[]
  /** Skills whose SKILL.md body was restored from a preimage, in ledger order. */
  restoredFiles: string[]
}

/** One ledger pass summary for status surfaces. */
export interface PassSummary {
  /** Pass identity. */
  passId: string
  /** ISO-8601 instant the pass ran. */
  at: string
  /** Snapshot tarball filename. */
  snapshot: string
  /** Counted transition entries. */
  transitions: number
}

/** One agent-created skill awaiting a consolidation verdict, with the evidence the verdict needs. */
export interface SurveyCandidate {
  /** Skill name. */
  name: string
  /** Catalog routing description, or empty when the catalog lacks the skill. */
  description: string
  /** Discovery source, or `custom` when the catalog lacks the skill. */
  source: string
  /** Current lifecycle state. */
  state: SkillLifecycleState
  /** Whole idle days since last use, or seeding when never used. */
  idleDays: number
  /** Successful model loads through the skill tool. */
  useCount: number
  /** Human views of the skill. */
  viewCount: number
  /** Mutations through skill management. */
  patchCount: number
  /** ISO-8601 instant of the last load, or null when never loaded. */
  lastUsedAt: string | null
  /**
   * Graded failures recorded in the sessions that loaded this skill, most
   * decisive first and capped by `maxCandidateFailures`. Empty when no
   * feedback store is mounted or none of those sessions failed.
   */
  failures: readonly FeedbackSignal[]
  /** Trust standing the pass recorded for this skill. */
  trust: SkillTrustState
  /** Body revisions recorded for this skill. */
  revision: number
  /** sha256-hex of the current body, or null when never written through telemetry. */
  contentSha: string | null
  /** Most recent failure attributed to this skill, or null when none. */
  lastTrustFailure: SkillTrustFailure | null
}

/** Agent-created skills awaiting a consolidation verdict, sorted by name. */
export interface ConsolidationSurvey {
  /** ISO-8601 instant the survey ran. */
  at: string
  /** Verdict evidence per skill. */
  candidates: SurveyCandidate[]
}

/** One skill removed by a purge. */
export interface PurgedSkill {
  /** Skill name. */
  name: string
  /** Removed directory, or null for record-only purges. */
  dir: string | null
}

/** Outcome of one purge over archived skills. */
export interface PurgeReport {
  /** ISO-8601 instant the purge ran. */
  at: string
  /** Whether the purge previewed without writing. */
  dryRun: boolean
  /** Skills purged, in catalog order. */
  purged: PurgedSkill[]
  /** Archived skills skipped for pinning. */
  skippedPinned: number
}

/** One decided verdict for an agent-created skill. */
export interface ConsolidationVerdict {
  /** Skill name the verdict targets. */
  name: string
  /** Keep the skill, rewrite its body, merge it into an umbrella, or archive its package. */
  action: 'keep' | 'patch' | 'consolidate' | 'archive'
  /** Umbrella skill receiving a merge. */
  into?: string | undefined
  /** Replacement `SKILL.md` body for `patch`. */
  body?: string | undefined
}

/** Ledger cost row proving what one consolidation fork was allowed to spend. */
export interface ConsolidationCost {
  /** Bytes of the framed survey sent to the fork. */
  inputBytes: number
  /** Output-token cap given to every fork request. */
  maxOutputTokens: number
  /** Provider route the fork used. */
  provider: string
  /** Model id the fork used. */
  model: string
  /** Whether the survey frame dropped candidates to fit `maxInputBytes`. */
  truncated: boolean
}

/** One patch body the verifier ladder, or the curator's own diff-size or required-pass gate, refused. */
export interface ConsolidationRefusal {
  /** Skill name the refused body targeted. */
  name: string
  /**
   * Verifier rung that refused the body; `'diff-cap'` for the curator-owned
   * size gate the ladder does not run; `'ladder-incomplete'` when
   * `requireVerifierPass` demanded a full pass and the ladder abstained
   * instead — nothing failed, but nothing decided either.
   */
  level: VerifierLevel | 'diff-cap' | 'ladder-incomplete'
  /** The rung's name and reason, as the verdict phrased it. */
  reason: string
}

/** Outcome of one consolidation run over agent-created skills. */
export interface ConsolidationReport {
  /** ISO-8601 instant the run started. */
  at: string
  /** Pass identity when a snapshot was written, or null. */
  passId: string | null
  /** Snapshot tarball filename when a snapshot was written, or null. */
  snapshot: string | null
  /** Cost row recorded before the fork started. */
  cost: ConsolidationCost
  /** Verdicts the fork returned, in tool-call order. */
  verdicts: ConsolidationVerdict[]
  /** Requested verdicts skipped as ineligible or unsafe. */
  skipped: number
  /** Patch bodies the verifier ladder refused, each naming the level that decided. */
  refusals: ConsolidationRefusal[]
  /** Fork requests spent. */
  steps: number
}

/** One skill a pass staged for review, with the outcome evidence that selected it. */
export interface StagedCandidate {
  /** Skill name. */
  name: string
  /** Successful loads recorded beside the failures. */
  useCount: number
  /** Recorded failed loads. */
  failureCount: number
  /** Failures as a share of every recorded load, in 0..1. */
  failureRate: number
  /** Why the pass staged it. */
  reason: string
}

/** One staged skill read back from the ledger, carrying its staging instant. */
export interface StagedSkill extends StagedCandidate {
  /** ISO-8601 instant the staging entry was appended. */
  at: string
}

/** Thresholds the staging step reads to decide whether a record speaks. */
export interface StageThresholds {
  /** Recorded loads required before a failure rate counts. */
  minUses: number
  /** Failure share a record must exceed, in 0..1. */
  failureRate: number
}
