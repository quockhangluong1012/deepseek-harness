/**
 * Pure helpers for evolution-budget: the candidate-class multipliers, the
 * allocation builder that prices a candidate class from the base ceilings,
 * the settlement arithmetic that says whether a spend stayed inside, and the
 * successive-halving screening schedule. No I/O, no domain — fully
 * unit-testable.
 * @module @deepseek-ai/dsh-evolution-budget/src/budget
 */

import type { AllocationInput, BudgetAllocation, BudgetSettlement, CandidateClass, HalvingRound, SpendRecord } from './types.ts'

/** The four §37 candidate classes, in canonical order. */
export const CANDIDATE_CLASSES: readonly CandidateClass[] = ['high-potential', 'standard', 'novel', 'low-potential']

/**
 * The budget multiplier of one candidate class: high-potential candidates
 * get twice the base, novel candidates an exploration allowance above the
 * standard, and low-potential candidates a cheap early-stop screen.
 * @param candidateClass - the class to price.
 * @returns the multiplier.
 */
export function multiplierFor(candidateClass: CandidateClass): number {
  switch (candidateClass) {
    case 'high-potential':
      return 2
    case 'novel':
      return 1.25
    case 'low-potential':
      return 0.5
    case 'standard':
      return 1
  }
}

/**
 * Build one budget allocation by pricing a candidate class against the base
 * ceilings. The reason names the multiplier and the numbers it produced.
 * @param input - the batch, its task class, and its candidate class.
 * @param baseMaxTokens - the base token ceiling of one standard batch.
 * @param baseMaxWallTimeMs - the base wall-time ceiling of one standard batch.
 * @param at - ISO-8601 instant of the allocation.
 * @returns the allocation.
 */
export function buildAllocation(
  input: AllocationInput,
  baseMaxTokens: number,
  baseMaxWallTimeMs: number,
  at: string,
): BudgetAllocation {
  const multiplier = multiplierFor(input.candidateClass)
  const maxTokens = Math.round(baseMaxTokens * multiplier)
  const maxWallTimeMs = Math.round(baseMaxWallTimeMs * multiplier)
  return {
    batchId: input.batchId,
    taskClass: input.taskClass,
    candidateClass: input.candidateClass,
    maxTokens,
    maxWallTimeMs,
    reason: `class '${input.candidateClass}' gets ×${multiplier} budget (${baseMaxTokens} → ${maxTokens} tokens, ${baseMaxWallTimeMs} → ${maxWallTimeMs} ms)`,
    at,
  }
}

/**
 * Settle a batch's cumulative spend against its allocation: the remaining
 * margins floor at zero, and the exceeded margins carry what ran past.
 * @param allocation - the allocation the batch was priced with.
 * @param spent - the cumulative spend records of the batch.
 * @returns the settlement with its exact margins.
 */
export function settle(
  allocation: BudgetAllocation,
  spent: readonly SpendRecord[],
): BudgetSettlement {
  const tokens = spent.reduce((sum, record) => sum + record.tokens, 0)
  const wallTimeMs = spent.reduce((sum, record) => sum + record.wallTimeMs, 0)
  return {
    batchId: allocation.batchId,
    allocation,
    tokens,
    wallTimeMs,
    remainingTokens: Math.max(0, allocation.maxTokens - tokens),
    remainingWallTimeMs: Math.max(0, allocation.maxWallTimeMs - wallTimeMs),
    exceededTokens: Math.max(0, tokens - allocation.maxTokens),
    exceededWallTimeMs: Math.max(0, wallTimeMs - allocation.maxWallTimeMs),
  }
}

/**
 * Whether a cumulative spend stays inside its allocation on both dimensions.
 * @param allocation - the allocation to check against.
 * @param spent - the cumulative spend records.
 * @returns true when both ceilings hold.
 */
export function withinAllocation(
  allocation: BudgetAllocation,
  spent: readonly SpendRecord[],
): boolean {
  const tokens = spent.reduce((sum, record) => sum + record.tokens, 0)
  const wallTimeMs = spent.reduce((sum, record) => sum + record.wallTimeMs, 0)
  return tokens <= allocation.maxTokens && wallTimeMs <= allocation.maxWallTimeMs
}

/**
 * The successive-halving screening schedule (§38): each round evaluates the
 * count the previous round kept, keeps the best `keepFraction` of them (at
 * least one), and hands that count to the next round. A keep fraction of 0.5
 * halves the evaluated candidates every round.
 * @param startCount - candidates entering round 1.
 * @param keepFraction - share of evaluated candidates kept each round (0 to 1).
 * @param roundCount - number of screening rounds.
 * @returns the rounds, first to last.
 */
export function halvingRounds(startCount: number, keepFraction: number, roundCount: number): HalvingRound[] {
  const rounds: HalvingRound[] = []
  let evaluateCount = startCount
  for (let round = 1; round <= roundCount; round += 1) {
    const keepCount = Math.max(1, Math.floor(evaluateCount * keepFraction))
    rounds.push({ round, evaluateCount, keepCount })
    evaluateCount = keepCount
  }
  return rounds
}