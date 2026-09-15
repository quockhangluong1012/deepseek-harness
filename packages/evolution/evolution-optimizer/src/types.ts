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
  /** SHA-256 of the promoted body, absent when nothing was promoted. */
  winnerSha: string | null
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
  /** Search scenarios the run evaluated. */
  scenarios: readonly string[]
  /** Provider route the mutation used. */
  provider: string
  /** Model id the mutation used. */
  model: string
  /** Skill body the run started from. */
  body: string
  /** Attempts per scenario the run's triples were measured with. */
  samples: number
  /** Promoted body, absent when nothing was promoted. */
  winnerBody: string | null
}
