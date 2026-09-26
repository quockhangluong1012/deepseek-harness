/**
 * Public type vocabulary of the evolution-budget store: the candidate
 * classes, one durable budget allocation, one recorded spend, the settlement
 * that says whether the spend stayed inside its allocation, the recorded
 * candidate pool with the §37 allocation-policy decision and the §38
 * successive-halving schedule, and the §27 resource-aware objectives those
 * records answer. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-budget/src/types
 */

/** The candidate classes the allocation policy prices differently. */
export type CandidateClass = 'high-potential' | 'standard' | 'novel' | 'low-potential'

/** One task class a budget batch covers, e.g. a skill name. */
export type BudgetTaskClass = string

/** The §37 allocation-policy branch a candidate is priced through. */
export type AllocationBranch = 'more-budget' | 'early-stop' | 'exploration-budget' | 'standard'

/** One allocation offered for a batch. */
export interface AllocationInput {
  /** Batch identity (the allocation key). */
  batchId: string
  /** The task class the batch optimizes. */
  taskClass: BudgetTaskClass
  /** The candidate class the batch prices. */
  candidateClass: CandidateClass
  /**
   * Why the policy chose that class from recorded evidence, folded into the
   * stored reason so the allocation names the branch that produced it.
   */
  policyReason?: string
}

/** One durable budget allocation for a batch. */
export interface BudgetAllocation {
  /** Batch identity (the allocation key). */
  batchId: string
  /** The task class the batch optimizes. */
  taskClass: BudgetTaskClass
  /** The candidate class the batch prices. */
  candidateClass: CandidateClass
  /** Token ceiling of the batch. */
  maxTokens: number
  /**
   * Ceiling on the wall time the batch's recorded spends sum to, in
   * milliseconds. Distinct from `timeLimitMs`, which bounds the calendar
   * span: heavy queueing burns the deadline without recording spend.
   */
  maxWallTimeMs: number
  /**
   * Cost ceiling of the batch in the deployment's cost units, or absent on a
   * record written before §37's cost dimension. Absent is not zero: an
   * unpriced ceiling bounds nothing.
   */
  maxCost?: number | undefined
  /**
   * Deadline of the batch in milliseconds from `at`, or absent on a record
   * written before §37's time-limit dimension.
   */
  timeLimitMs?: number | undefined
  /**
   * Candidates the batch may evaluate concurrently, or absent on a record
   * written before §37's parallelism dimension.
   */
  parallelism?: number | undefined
  /** Why the class received its multiplier, naming the numbers. */
  reason: string
  /** ISO-8601 instant the allocation was recorded. */
  at: string
}

/** One spend offered for a batch. */
export interface SpendInput {
  /** Tokens spent. */
  tokens: number
  /** Wall time spent, in milliseconds. */
  wallTimeMs: number
  /** Candidates evaluated (rollouts) in the batch. */
  rollouts: number
  /**
   * Billed cost of the spend in the deployment's cost units, or absent when
   * the deployment has no cost meter.
   */
  cost?: number | undefined
  /** Peak candidates the spend evaluated concurrently, or absent when unmeasured. */
  parallelism?: number | undefined
  /**
   * Offline tokens the spend attributed to the batch — a background
   * precompute serving it — or absent when the batch attributed none.
   */
  backgroundTokens?: number | undefined
}

/** One durable spend record of a batch. */
export interface SpendRecord extends SpendInput {
  /** Batch the spend belongs to. */
  batchId: string
  /** ISO-8601 instant the spend was recorded. */
  at: string
}

/**
 * One budget dimension's margin. A dimension is measured only when the
 * allocation prices it and something records it; an unmeasured side is null
 * rather than a zero that would read as a measurement.
 */
export interface BudgetMargin {
  /** The ceiling, or null when the allocation prices no ceiling here. */
  budgeted: number | null
  /** What the batch recorded for the dimension, or null when nothing did. */
  spent: number | null
  /** Ceiling left (0 when the ceiling is reached or passed), or null when unmeasured. */
  remaining: number | null
  /** Amount past the ceiling (0 when inside), or null when unmeasured. */
  exceeded: number | null
}

/** Whether a spend stayed inside its allocation, with the exact margins. */
export interface BudgetSettlement {
  /** Batch the settlement covers. */
  batchId: string
  /** The allocation the batch was priced with. */
  allocation: BudgetAllocation
  /** Cumulative tokens spent on the batch. */
  tokens: number
  /** Cumulative wall time spent on the batch, in milliseconds. */
  wallTimeMs: number
  /** Tokens left before the ceiling (0 when exceeded). */
  remainingTokens: number
  /** Wall time left before the ceiling (0 when exceeded). */
  remainingWallTimeMs: number
  /** Tokens spent past the ceiling (0 when inside). */
  exceededTokens: number
  /** Wall time spent past the ceiling (0 when inside). */
  exceededWallTimeMs: number
  /** Cost margin: `spent` is the batch's recorded billed cost. */
  cost: BudgetMargin
  /** Deadline margin: `spent` is the milliseconds elapsed to the last recorded spend. */
  time: BudgetMargin
  /** Concurrency margin: `spent` is the highest concurrency the batch recorded. */
  parallelism: BudgetMargin
}

/**
 * What background work has spent across every recorded batch, and nothing
 * else: no ceiling, no margin, and no verdict on what the work was worth. The
 * kernel's `BudgetGovernor` reports this beside a session's own use, so a
 * caller of the governor reads both budget owners from one call.
 */
export interface RecordedBackgroundSpend {
  /** Tokens every recorded spend billed. */
  tokens: number
  /** Wall-clock milliseconds every recorded spend took. */
  wallMs: number
  /**
   * Billed cost in the deployment's own cost units, absent when any recorded
   * spend states no cost: a partial sum would read as what all of background
   * work cost, and a zero would read as a measurement no spend made.
   */
  cost?: number | undefined
}

/** One candidate offered for a batch's recorded screening pool (§38). */
export interface PooledCandidateInput {
  /** Candidate identity within the batch. */
  candidateId: string
  /** Evaluations recorded for the candidate. */
  runs: number
  /** Passes among those evaluations. */
  passes: number
  /** Novelty of the candidate against the body the run started from, in 0..1. */
  novelty: number
}

/** One durable member of a batch's screening pool. */
export interface PooledCandidate extends PooledCandidateInput {
  /** Batch whose screening pool holds the candidate. */
  batchId: string
  /** The task class the batch optimizes. */
  taskClass: BudgetTaskClass
  /** ISO-8601 instant the candidate was recorded. */
  at: string
}

/** One batch's candidate pool offered for recording. */
export interface PoolInput {
  /** Batch whose screening pool these candidates belong to. */
  batchId: string
  /** The task class the batch optimizes. */
  taskClass: BudgetTaskClass
  /** The candidates entering the pool. */
  candidates: readonly PooledCandidateInput[]
}

/** The recorded-evidence bars the §37 allocation policy decides by. */
export interface PolicyThresholds {
  /** Passes that make a candidate proven high-potential. */
  provenPasses: number
  /** Recorded evaluations a zero-pass candidate needs to count as low-potential. */
  lowPotentialRuns: number
  /** Novelty that earns an unproven candidate the exploration branch. */
  noveltyThreshold: number
}

/** The allocation policy's decision for one recorded candidate. */
export interface PolicyDecision {
  /** The candidate the decision covers. */
  candidateId: string
  /** The class the candidate's budget is priced as. */
  candidateClass: CandidateClass
  /** The §37 branch the decision came from. */
  branch: AllocationBranch
  /** Why that branch won, naming the recorded numbers. */
  reason: string
}

/** One round of the successive-halving screening schedule (§38). */
export interface HalvingRound {
  /** Round number, starting at 1. */
  round: number
  /** Candidates the round evaluates. */
  evaluateCount: number
  /** Candidates the round keeps for the next round. */
  keepCount: number
}

/** The successive-halving schedule the recorded pool implies (§38). */
export interface HalvingSchedule {
  /** Candidates the recorded pool holds entering round 1. */
  entered: number
  /** Rounds, first to last. */
  rounds: readonly HalvingRound[]
  /** Candidates the last round keeps: the finals a full evaluation would judge. */
  finalists: number
}

/** One §27 resource-aware objective. */
export type EvolutionObjective =
  | 'quality'
  | 'reliability'
  | 'latency'
  | 'cost'
  | 'memory-footprint'
  | 'context-usage'
  | 'background-compute'

/** How to read an objective's number. */
export type ObjectiveUnit = 'share' | 'milliseconds' | 'tokens' | 'bytes'

/** One objective read from the batch's recorded pool and spends. */
export interface ObjectiveReading {
  /** The objective the reading covers. */
  objective: EvolutionObjective
  /** The unit the value is in. */
  unit: ObjectiveUnit
  /** The measured value, or null when no record holds it. */
  value: number | null
  /** The record the value comes from, or the record the objective is missing. */
  source: string
}
