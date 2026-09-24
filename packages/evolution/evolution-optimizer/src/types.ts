/**
 * Optimizer vocabulary: the request one optimization run takes, one evaluated
 * variant, and the report it returns. Metric triples come from the scorer;
 * the optimizer only selects over them.
 * @module @deepseek-ai/dsh-evolution-optimizer/types
 */

import type { AgentUnderTest } from '@deepseek-ai/dsh-session-snapshot'
import type { ScenarioRunner, SkillScore } from '@deepseek-ai/dsh-evolution-scorer'
import type { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'

/** One optimization run: which skill, over which corpus scenarios, staged where. */
export interface OptimizeRequest {
  /** Skill to optimize; must name a skill the skill catalog resolves. */
  skill: string
  /** Scenario directory names inside the scorer's corpus, in run order. */
  scenarios: readonly string[]
  /** Agent composition the runner boots; the scorer always runs it in keyless replay mode. */
  agent?: AgentUnderTest | undefined
  /** Fresh-process runner; omitted runs fall back to the scorer's process runner. */
  run?: ScenarioRunner | undefined
  /** Scope the winning patch stages into. */
  scopeId: EvolutionScopeId
  /** Session the run is attributed to on the staged entry. */
  originSessionId: string
  /** Failure evidence framed into the mutation prompt; defaults to the trigger counts. */
  evidence?: string | undefined
  /** Caller cancellation forwarded to the mutation request and every score. */
  signal?: AbortSignal | undefined
}

/** One mutation candidate with its measured triple. */
export interface EvaluatedVariant {
  /** Candidate index in mutation order; -1 names the re-scored baseline. */
  index: number
  /** Complete replacement SKILL.md body the candidate carries. */
  body: string
  /** Id of the mutation operator that produced the body. */
  operator: string
  /**
   * Share of the body's distinct instruction lines the starting body does not
   * already contain, in 0..1: how much new material this candidate states.
   */
  novelty: number
  /**
   * Archive novelty of the body's descriptor against the skill's recorded
   * archive, in 0..1: how far this candidate sits from everything the skill
   * has already staged. One for every candidate when the archive is empty or
   * the novelty store is unmounted, which leaves the ranking to cost, body
   * novelty, and mutation order alone.
   */
  archiveNovelty: number
  /** Aggregated triple over the request's scenarios. */
  score: SkillScore
}

/**
 * How many paired winner-versus-baseline comparisons a promotion won. `runs`
 * counts the comparisons made and `wins` those the winner took; promotion
 * requires them to be equal.
 */
export interface PromotionConfidence {
  /** Paired comparisons the run made. */
  runs: number
  /** Comparisons the winner beat the baseline in. */
  wins: number
}

/** The winner's holdout check: the same private scenarios scored for both bodies. */
export interface HoldoutCheck {
  /** Triple the baseline scored on the holdout scenarios. */
  baseline: SkillScore
  /** Triple the winning variant scored on the holdout scenarios. */
  winner: SkillScore
}

/** Outcome of one optimization run. */
export interface OptimizeReport {
  /** Skill the run optimized. */
  skill: string
  /**
   * `staged` names a staged skill patch; `holdout-rejected` names a winner the
   * private scenarios do not support; `no-improvement` names a run that never
   * beat the baseline; `skipped` names a run that never evaluated a candidate.
   */
  status: 'staged' | 'regressed' | 'unconfirmed' | 'holdout-rejected' | 'no-improvement' | 'skipped'
  /** Baseline triple re-scored under the same overlay harness as the variants. */
  baseline: SkillScore | null
  /** Every variant the run fully evaluated, in mutation order. */
  candidates: readonly EvaluatedVariant[]
  /** Staged entry id; present only when `status` is `staged`. */
  stagedId: string | null
  /** Human-readable reason; present unless `status` is `staged`. */
  reason: string | null
  /** Holdout triples when the run configured one, else null. */
  holdout: HoldoutCheck | null
  /** Approved floor the run measured its winner against, when one exists. */
  floor: RegressionFloor | null
  /**
   * Whether the skill stagnated — its recent evaluated runs promoted nothing —
   * so this run drew its candidates from the operators those runs had not used.
   */
  stagnant: boolean
  /** Paired-comparison tally when the run confirmed its winner, else null. */
  confidence: PromotionConfidence | null
  /** Whether the run stopped evaluating candidates early because its budget was spent. */
  truncated: boolean
}

/** One measured triple as the experiment ledger stores it. */
export interface ExperimentTriple {
  /** Whether every scenario passed. */
  pass: boolean
  /** Billed tokens the comparison spent. */
  tokens: number
  /** Wall time in milliseconds the comparison spent. */
  wallTimeMs: number
}

/** One durable record of a run that reached evaluation, newest-first when read. */
export interface ExperimentRecord {
  /** Ledger identity. */
  id: string
  /** ISO-8601 instant the run recorded. */
  at: string
  /** Scope the run staged into. */
  scope: string
  /** Skill the run optimized. */
  skill: string
  /** Failure evidence the mutation addressed. */
  evidence: string
  /** Mutation operators that produced the evaluated candidates. */
  operators: readonly string[]
  /** Mutation operators the run drew from, whether or not they produced a candidate. */
  portfolio: readonly string[]
  /**
   * Operators whose candidates stated at least one instruction line the run's
   * starting body did not carry: the ones that did not merely restate it.
   */
  novelOperators: readonly string[]
  /** Search scenarios the run evaluated. */
  scenarios: readonly string[]
  /** Holdout scenarios the run checked, empty when none were configured. */
  holdout: readonly string[]
  /** Baseline triple, absent for a run that never scored one. */
  baseline: ExperimentTriple | null
  /** Winning triple the run considered, absent when nothing beat the baseline. */
  winner: ExperimentTriple | null
  /** Paired-comparison tally, absent when the run did not confirm its winner. */
  confidence: PromotionConfidence | null
  /** Attempts per scenario the winner's triple was measured with. */
  samples: number
  /** What the run decided. */
  outcome: 'staged' | 'regressed' | 'unconfirmed' | 'holdout-rejected' | 'no-improvement' | 'skipped'
  /** Why it decided that, absent on a promotion. */
  reason: string | null
  /** Staged entry a promotion created, absent otherwise. */
  stagedId: string | null
  /** Provider route the mutation used. */
  provider: string
  /** Model id the mutation used. */
  model: string
  /** SHA-256 of the skill body the run started from. */
  bodySha: string
  /** Scoring-semantics version the run measured under; rows stamped older are incomparable. */
  scorerVersion: number
  /** Lines the promoted body added over the starting body, zero when nothing was promoted. */
  addedLines: number
  /** Lines the promoted body removed from the starting body, zero when nothing was promoted. */
  removedLines: number
  /** SHA-256 of the promoted body, absent when nothing was promoted. */
  winnerSha: string | null
  /** Operator that produced the promoted body, absent when nothing was promoted. */
  winnerOperator: string | null
  /**
   * Archive novelty the promoted body measured against the skill's archive
   * when the run ranked it, in 0..1; null when nothing was promoted and on
   * rows recorded before this field existed, which read as never measured.
   */
  winnerArchiveNovelty?: number | null
  /**
   * Combined content digest of the recorded fixture(s) behind the winner's
   * (or, absent a winner, the baseline's) per-scenario scores; null when the
   * run never scored anything and on rows recorded before this field
   * existed. §24.3 repository fixture digest.
   */
  fixtureDigest?: string | null
  /**
   * Harvested session ids of the scored scenarios' first attempt, in
   * scenario order; empty when the run never scored anything or harvested no
   * session. §24.3 trajectory.
   */
  trajectory?: readonly string[]
  /**
   * Named dsh profile the run's agent composition booted under, absent for a
   * test-only fake bin with its own config grammar. §24.3 policy profile.
   */
  policyProfile?: string | null
  /**
   * JSON of the frontmatter contract gate's verdict on the promoted body —
   * the only verifier this optimizer itself runs before landing a candidate
   * — absent when nothing was promoted. Not the curator's fuller verifier
   * ladder and not the scorer's routing/replay behavior gates, neither of
   * which this run consults. §24.3 verifier output.
   */
  verifierOutput?: string | null
}

/** Query one scope's experiment ledger. */
export interface ExperimentsQuery {
  /** Restrict the page to one skill. */
  skill?: string | undefined
  /** Maximum rows to return, newest first. */
  limit?: number | undefined
}

/** An approved promotion a new candidate is measured against. */
export interface RegressionFloor {
  /** Triple the approved body scored on the same scenarios. */
  triple: ExperimentTriple
  /** Staged entry that approval decided. */
  stagedId: string
  /** ISO-8601 instant the approved run recorded. */
  at: string
}

/** Facts one run hands to the ledger once it has scored something. */
export interface ExperimentDraft {
  /** Failure evidence the mutation addressed. */
  evidence: string
  /** Mutation operators that produced the evaluated candidates. */
  operators: readonly string[]
  /** Mutation operators the run drew from. */
  portfolio: readonly string[]
  /** Operators whose candidates stated material the starting body lacked. */
  novelOperators: readonly string[]
  /** Search scenarios the run evaluated. */
  scenarios: readonly string[]
  /** Provider route the mutation used. */
  provider: string
  /** Model id the mutation used. */
  model: string
  /** Scoring-semantics version the mounted scorer measured under. */
  scorerVersion: number

  /** Skill body the run started from. */
  body: string
  /** Attempts per scenario the run's triples were measured with. */
  samples: number
  /** Winning candidate, absent when nothing was promoted. */
  winner: EvaluatedVariant | null
  /**
   * Archive novelty the winning candidate was ranked on, absent when nothing
   * was promoted: how far the promoted body sat from the skill's recorded
   * history when the pick was made.
   */
  winnerArchiveNovelty: number | null
  /** Named dsh profile the run's agent composition booted under, or null. */
  agentProfile: string | null
}
