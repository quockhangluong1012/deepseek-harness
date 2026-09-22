/**
 * Pure helpers for evolution-budget: the candidate-class multipliers, the
 * allocation builder that prices a candidate class from the base ceilings, the
 * ceilings §37 adds beside the frozen builder — cost, deadline, and
 * parallelism — the settlement arithmetic that says whether a spend stayed
 * inside, and the successive-halving schedule a recorded candidate pool
 * implies. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-budget/src/budget
 */

import type {
  AllocationInput,
  BudgetAllocation,
  BudgetMargin,
  BudgetSettlement,
  CandidateClass,
  HalvingRound,
  HalvingSchedule,
  PooledCandidate,
  SpendRecord,
} from './types.ts'

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

/** The deployment's base ceilings of the §37 dimensions {@link buildAllocation} does not price. */
export interface DimensionBases {
  /** Base cost ceiling of one standard batch, in the deployment's cost units. */
  baseMaxCost: number
  /** Base deadline of one standard batch, in milliseconds from its allocation. */
  baseTimeLimitMs: number
  /** Base concurrency ceiling of one standard batch. */
  baseParallelism: number
}

/** One priced dimension with the reason it carries. */
export interface PricedDimensions {
  /** Cost ceiling of the batch. */
  maxCost: number
  /** Deadline of the batch, in milliseconds from its allocation. */
  timeLimitMs: number
  /** Concurrency ceiling of the batch. */
  parallelism: number
  /** The clause an allocation's reason appends, naming every priced number. */
  reason: string
}

/**
 * Price §37's cost, deadline, and parallelism dimensions by the same class
 * multiplier the token and wall-time ceilings use. A batch always keeps one
 * worker: halving the base must not round parallelism away.
 * @param candidateClass - the class to price.
 * @param bases - the deployment's base ceilings.
 * @returns the three ceilings and the clause naming them.
 */
export function dimensionCeilings(candidateClass: CandidateClass, bases: DimensionBases): PricedDimensions {
  const multiplier = multiplierFor(candidateClass)
  const maxCost = Math.round(bases.baseMaxCost * multiplier)
  const timeLimitMs = Math.round(bases.baseTimeLimitMs * multiplier)
  const parallelism = Math.max(1, Math.round(bases.baseParallelism * multiplier))
  return {
    maxCost,
    timeLimitMs,
    parallelism,
    reason: `cost ${maxCost} units, deadline ${timeLimitMs} ms, parallelism ${parallelism} (×${multiplier} of ${bases.baseMaxCost}/${bases.baseTimeLimitMs}/${bases.baseParallelism})`,
  }
}

/**
 * The storage key of one pooled candidate: the batch and the candidate joined.
 * @param batchId - the batch the candidate was pooled for.
 * @param candidateId - the candidate identity within the batch.
 * @returns the storage key.
 */
export function poolKey(batchId: string, candidateId: string): string {
  return `${batchId}\0${candidateId}`
}

/**
 * Settle a batch's cumulative spend against its allocation: the remaining
 * margins floor at zero, and the exceeded margins carry what ran past. The
 * token and wall-time dimensions are always measured because every spend
 * records them; cost, deadline, and parallelism are measured only when the
 * allocation prices them and the batch records them.
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
    cost: marginOf(allocation.maxCost ?? null, recordedTotal(spent, record => record.cost)),
    time: marginOf(allocation.timeLimitMs ?? null, elapsedMsOf(allocation, spent)),
    parallelism: marginOf(allocation.parallelism ?? null, optionalPeak(spent, record => record.parallelism)),
  }
}

/**
 * Whether a cumulative spend stays inside its allocation. A dimension the
 * allocation does not price, or that nothing recorded, cannot be violated.
 * @param allocation - the allocation to check against.
 * @param spent - the cumulative spend records.
 * @returns true when every measured ceiling holds.
 */
export function withinAllocation(
  allocation: BudgetAllocation,
  spent: readonly SpendRecord[],
): boolean {
  const settlement = settle(allocation, spent)
  return settlement.exceededTokens === 0
    && settlement.exceededWallTimeMs === 0
    && (settlement.cost.exceeded ?? 0) === 0
    && (settlement.time.exceeded ?? 0) === 0
    && (settlement.parallelism.exceeded ?? 0) === 0
}

/**
 * The successive-halving screening schedule (§38) of a recorded candidate
 * pool: each round evaluates the count the previous round kept, keeps the
 * best `keepFraction` of them (at least one), and hands that count to the next
 * round. Which candidates a round actually keeps is the screen's decision, not
 * this schedule's.
 * @param pool - the batch's recorded candidate pool.
 * @param keepFraction - share of evaluated candidates kept each round (0 to 1).
 * @param roundCount - number of screening rounds.
 * @returns the schedule, first round to last.
 */
export function screeningSchedule(
  pool: readonly PooledCandidate[],
  keepFraction: number,
  roundCount: number,
): HalvingSchedule {
  if (pool.length === 0) return { entered: 0, rounds: [], finalists: 0 }
  const rounds = halvingRounds(pool.length, keepFraction, roundCount)
  return {
    entered: pool.length,
    rounds,
    finalists: rounds[rounds.length - 1]?.keepCount ?? 0,
  }
}

/**
 * The successive-halving screening schedule of a candidate count: each round
 * evaluates the count the previous round kept, keeps the best `keepFraction`
 * of them (at least one), and hands that count to the next round. A keep
 * fraction of 0.5 halves the evaluated candidates every round.
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

/**
 * One budget dimension's margin. A dimension is measured only when a ceiling
 * and a measurement are both recorded; either side missing reports null
 * throughout rather than a zero that would read as a measurement.
 * @param budgeted - the ceiling, or null when the allocation prices none.
 * @param spent - the recorded measurement, or null when nothing recorded one.
 * @returns the margin.
 */
function marginOf(budgeted: number | null, spent: number | null): BudgetMargin {
  if (budgeted === null || spent === null) return { budgeted, spent, remaining: null, exceeded: null }
  return {
    budgeted,
    spent,
    remaining: Math.max(0, budgeted - spent),
    exceeded: Math.max(0, spent - budgeted),
  }
}

/**
 * The total of one optional spend dimension over a batch's spends, or null
 * when no spend is recorded or any spend omits the dimension: a partial sum
 * would read as a whole-batch total.
 * @param spent - the batch's spend records.
 * @param pick - the dimension's value on one record.
 * @returns the total, or null when the dimension is unrecorded.
 */
export function recordedTotal(spent: readonly SpendRecord[], pick: (record: SpendRecord) => number | undefined): number | null {
  if (spent.length === 0) return null
  let total = 0
  for (const record of spent) {
    const value = pick(record)
    if (value === undefined) return null
    total += value
  }
  return total
}

/**
 * The highest value of one optional spend dimension over a batch's spends, or
 * null when no spend is recorded or any spend omits the dimension: a peak
 * over part of a batch could sit below the ceiling while the batch's real peak
 * crossed it.
 * @param spent - the batch's spend records.
 * @param pick - the dimension's value on one record.
 * @returns the peak, or null when the dimension is unrecorded.
 */
function optionalPeak(spent: readonly SpendRecord[], pick: (record: SpendRecord) => number | undefined): number | null {
  if (spent.length === 0) return null
  let peak = Number.NEGATIVE_INFINITY
  for (const record of spent) {
    const value = pick(record)
    if (value === undefined) return null
    if (value > peak) peak = value
  }
  return peak
}

/**
 * Milliseconds the batch has consumed of its deadline: from the allocation
 * instant to its last recorded spend. A batch with no recorded spend has no
 * recorded activity to measure elapsed against, and a record whose instants do
 * not parse is unmeasured rather than reported as zero.
 * @param allocation - the allocation the batch was priced with.
 * @param spent - the batch's spend records.
 * @returns the elapsed milliseconds, or null when unmeasured.
 */
function elapsedMsOf(allocation: BudgetAllocation, spent: readonly SpendRecord[]): number | null {
  if (spent.length === 0) return null
  let latest = Number.NEGATIVE_INFINITY
  for (const record of spent) latest = Math.max(latest, Date.parse(record.at))
  const elapsed = latest - Date.parse(allocation.at)
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : null
}
