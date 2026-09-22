/**
 * Public type vocabulary of the evolution-budget store: the candidate
 * classes, one durable budget allocation, one recorded spend, the settlement
 * that says whether the spend stayed inside its allocation, and the
 * successive-halving schedule for screening candidates (§37, §38). Types only
 * — no runtime code.
 * @module @deepseek-ai/dsh-evolution-budget/src/types
 */

/** The candidate classes the allocation policy prices differently. */
export type CandidateClass = 'high-potential' | 'standard' | 'novel' | 'low-potential'

/** One task class a budget batch covers, e.g. a skill name. */
export type BudgetTaskClass = string

/** One allocation offered for a batch. */
export interface AllocationInput {
  /** Batch identity (the allocation key). */
  batchId: string
  /** The task class the batch optimizes. */
  taskClass: BudgetTaskClass
  /** The candidate class the batch prices. */
  candidateClass: CandidateClass
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
  /** Wall-time ceiling of the batch, in milliseconds. */
  maxWallTimeMs: number
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
}

/** One durable spend record of a batch. */
export interface SpendRecord extends SpendInput {
  /** Batch the spend belongs to. */
  batchId: string
  /** ISO-8601 instant the spend was recorded. */
  at: string
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