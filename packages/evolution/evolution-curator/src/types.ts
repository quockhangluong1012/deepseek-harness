/**
 * Public type vocabulary of the evolution curator: run options, transitions,
 * and the preview report. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-curator/src/types
 */

import type { SkillLifecycleState } from '@deepseek-ai/dsh-evolution-skill-telemetry'

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
   * Failures recorded in the sessions that loaded this skill, most-observed
   * first and capped by `maxCandidateFailures`. Empty when no feedback store is
   * mounted or none of those sessions failed.
   */
  failures: readonly SurveyFailure[]
}

/**
 * One failure observed while a surveyed skill was in play. This is the
 * reflection input a consolidation verdict reads: what actually went wrong in
 * the sessions that used the skill, not what its author predicted.
 */
export interface SurveyFailure {
  /** Tool whose call failed, or null when the failing call was not observed. */
  tool: string | null
  /** Failing result text, already normalized and clipped by the feedback store. */
  message: string
  /** Times the failure was observed across the correlated sessions. */
  count: number
  /** Distinct sessions that reported it. */
  sessions: number
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
  /** Fork requests spent. */
  steps: number
}
