import { describe, expect, it } from 'vitest'
import {
  buildAllocation,
  CANDIDATE_CLASSES,
  dimensionCeilings,
  halvingRounds,
  multiplierFor,
  poolKey,
  recordedTotal,
  screeningSchedule,
  settle,
  withinAllocation,
} from '../src/budget.ts'
import { budgetAllocationRow } from '../src/spec.ts'
import type { AllocationInput, BudgetAllocation, PooledCandidate, SpendRecord } from '../src/types.ts'

const input = (overrides: Partial<AllocationInput> = {}): AllocationInput => ({
  batchId: 'b1',
  taskClass: 'writer',
  candidateClass: 'standard',
  ...overrides,
})

const allocation = (overrides: Partial<BudgetAllocation> = {}): BudgetAllocation => ({
  batchId: 'b1',
  taskClass: 'writer',
  candidateClass: 'standard',
  maxTokens: 20000,
  maxWallTimeMs: 600000,
  reason: 'class \'standard\' gets ×1 budget (20000 → 20000 tokens, 600000 → 600000 ms)',
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const spend = (overrides: Partial<SpendRecord> = {}): SpendRecord => ({
  batchId: 'b1',
  tokens: 5000,
  wallTimeMs: 60000,
  rollouts: 4,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const pooled = (candidateId: string, overrides: Partial<PooledCandidate> = {}): PooledCandidate => ({
  batchId: 'b1',
  candidateId,
  taskClass: 'writer',
  runs: 1,
  passes: 1,
  novelty: 0,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('CANDIDATE_CLASSES', () => {
  it('lists the four candidate classes in canonical order', () => {
    expect([...CANDIDATE_CLASSES]).toEqual(['high-potential', 'standard', 'novel', 'low-potential'])
  })
})

describe('multiplierFor', () => {
  it('prices high-potential at twice the base and low-potential at half', () => {
    expect(multiplierFor('high-potential')).toBe(2)
    expect(multiplierFor('standard')).toBe(1)
    expect(multiplierFor('novel')).toBe(1.25)
    expect(multiplierFor('low-potential')).toBe(0.5)
  })
})

describe('buildAllocation', () => {
  it('prices the class against the base ceilings and names the numbers', () => {
    const row = buildAllocation(input(), 20000, 600000, '2026-01-01T00:00:00.000Z')
    expect(row).toMatchObject({ batchId: 'b1', taskClass: 'writer', candidateClass: 'standard', maxTokens: 20000, maxWallTimeMs: 600000 })
    expect(row.reason).toBe('class \'standard\' gets ×1 budget (20000 → 20000 tokens, 600000 → 600000 ms)')
    expect(row.at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('doubles the ceilings for a high-potential batch', () => {
    const row = buildAllocation(input({ candidateClass: 'high-potential' }), 20000, 600000, '2026-01-01T00:00:00.000Z')
    expect(row.maxTokens).toBe(40000)
    expect(row.maxWallTimeMs).toBe(1200000)
  })

  it('halves the ceilings for a low-potential screen', () => {
    const row = buildAllocation(input({ candidateClass: 'low-potential' }), 20000, 600000, '2026-01-01T00:00:00.000Z')
    expect(row.maxTokens).toBe(10000)
    expect(row.maxWallTimeMs).toBe(300000)
  })
})

describe('dimensionCeilings', () => {
  const bases = { baseMaxCost: 10, baseTimeLimitMs: 3600000, baseParallelism: 4 }

  it('prices cost, deadline, and parallelism by the class multiplier', () => {
    expect(dimensionCeilings('standard', bases)).toEqual({
      maxCost: 10,
      timeLimitMs: 3600000,
      parallelism: 4,
      reason: 'cost 10 units, deadline 3600000 ms, parallelism 4 (×1 of 10/3600000/4)',
    })
    expect(dimensionCeilings('high-potential', bases)).toMatchObject({ maxCost: 20, timeLimitMs: 7200000, parallelism: 8 })
    expect(dimensionCeilings('novel', bases)).toMatchObject({ maxCost: 13, timeLimitMs: 4500000, parallelism: 5 })
  })

  it('keeps one worker when the low-potential screen halves the base', () => {
    expect(dimensionCeilings('low-potential', bases).parallelism).toBe(2)
    // A fractional base must not round the concurrency ceiling away.
    expect(dimensionCeilings('low-potential', { baseMaxCost: 1, baseTimeLimitMs: 1000, baseParallelism: 0 }).parallelism).toBe(1)
  })
})

describe('poolKey', () => {
  it('joins batch and candidate with a separator', () => {
    expect(poolKey('b1', 'c1')).toBe('b1\0c1')
  })
})

describe('settle', () => {
  it('reports the remaining margins when the spend stays inside', () => {
    const result = settle(allocation(), [spend()])
    expect(result).toMatchObject({
      batchId: 'b1',
      tokens: 5000,
      wallTimeMs: 60000,
      remainingTokens: 15000,
      remainingWallTimeMs: 540000,
      exceededTokens: 0,
      exceededWallTimeMs: 0,
    })
  })

  it('sums every spend record of the batch', () => {
    const result = settle(allocation(), [spend(), spend({ tokens: 12000, wallTimeMs: 66000 })])
    expect(result.tokens).toBe(17000)
    expect(result.wallTimeMs).toBe(126000)
  })

  it('floors the remaining at zero and reports the exceeded margins', () => {
    const result = settle(allocation({ maxTokens: 4000, maxWallTimeMs: 30000 }), [spend({ tokens: 5000, wallTimeMs: 60000 })])
    expect(result).toMatchObject({
      remainingTokens: 0,
      remainingWallTimeMs: 0,
      exceededTokens: 1000,
      exceededWallTimeMs: 30000,
    })
  })

  it('settles an empty spend at the full remaining ceilings', () => {
    const result = settle(allocation(), [])
    expect(result).toMatchObject({ tokens: 0, wallTimeMs: 0, remainingTokens: 20000, remainingWallTimeMs: 600000 })
  })

  it('settles the priced cost, deadline, and parallelism dimensions', () => {
    const priced = allocation({ maxCost: 10, timeLimitMs: 300000, parallelism: 4 })
    const result = settle(priced, [spend({ cost: 4, parallelism: 2 })])
    expect(result.cost).toEqual({ budgeted: 10, spent: 4, remaining: 6, exceeded: 0 })
    expect(result.time).toEqual({ budgeted: 300000, spent: 0, remaining: 300000, exceeded: 0 })
    expect(result.parallelism).toEqual({ budgeted: 4, spent: 2, remaining: 2, exceeded: 0 })
  })

  it('carries the exceeded side of a priced dimension', () => {
    const priced = allocation({ maxCost: 4, timeLimitMs: 1000, parallelism: 2 })
    const result = settle(priced, [
      spend({ cost: 3, parallelism: 2 }),
      spend({ cost: 3, parallelism: 3, at: '2026-01-01T00:10:00.000Z' }),
    ])
    expect(result.cost).toEqual({ budgeted: 4, spent: 6, remaining: 0, exceeded: 2 })
    expect(result.time).toEqual({ budgeted: 1000, spent: 600000, remaining: 0, exceeded: 599000 })
    expect(result.parallelism).toEqual({ budgeted: 2, spent: 3, remaining: 0, exceeded: 1 })
    // A peak that opens high keeps the value it opened with.
    expect(settle(allocation({ parallelism: 4 }), [spend({ parallelism: 3 }), spend({ parallelism: 1 })]).parallelism)
      .toEqual({ budgeted: 4, spent: 3, remaining: 1, exceeded: 0 })
  })

  it('leaves a dimension unmeasured when the allocation prices none or a spend omits it', () => {
    const unpriced = settle(allocation(), [spend({ cost: 4, parallelism: 2 })])
    expect(unpriced.cost).toEqual({ budgeted: null, spent: 4, remaining: null, exceeded: null })
    expect(unpriced.parallelism).toEqual({ budgeted: null, spent: 2, remaining: null, exceeded: null })

    const priced = allocation({ maxCost: 10, timeLimitMs: 1000, parallelism: 4 })
    // A partial total would read as a whole-batch figure, and a peak over part
    // of the batch could sit below the ceiling the batch crossed.
    const partial = settle(priced, [spend({ cost: 4, parallelism: 2 }), spend({ tokens: 1 })])
    expect(partial.cost).toEqual({ budgeted: 10, spent: null, remaining: null, exceeded: null })
    expect(partial.parallelism).toEqual({ budgeted: 4, spent: null, remaining: null, exceeded: null })

    const empty = settle(priced, [])
    expect(empty.cost.spent).toBeNull()
    expect(empty.time).toEqual({ budgeted: 1000, spent: null, remaining: null, exceeded: null })
  })

  it('measures elapsed from the allocation instant to the last recorded spend', () => {
    const result = settle(allocation({ timeLimitMs: 1000 }), [spend({ at: '2026-01-01T00:05:00.000Z' })])
    expect(result.time.spent).toBe(300000)
    // A spend stamped before its allocation is no elapsed time at all.
    expect(settle(allocation({ timeLimitMs: 1000 }), [spend({ at: '2025-12-31T23:00:00.000Z' })]).time.spent).toBe(0)
  })

  it('leaves the deadline unmeasured when an instant does not parse', () => {
    const result = settle(allocation({ timeLimitMs: 1000 }), [spend({ at: 'not-an-instant' })])
    expect(result.time).toEqual({ budgeted: 1000, spent: null, remaining: null, exceeded: null })
    expect(settle(allocation({ timeLimitMs: 1000 }), [spend()]).time.spent).toBe(0)
  })
})

describe('withinAllocation', () => {
  it('is true inside both ceilings and false past either', () => {
    expect(withinAllocation(allocation(), [spend()])).toBe(true)
    expect(withinAllocation(allocation({ maxTokens: 4000 }), [spend()])).toBe(false)
    expect(withinAllocation(allocation({ maxWallTimeMs: 30000 }), [spend()])).toBe(false)
  })

  it('fails on a priced dimension the spend crossed, and ignores an unmeasured one', () => {
    expect(withinAllocation(allocation({ maxCost: 4 }), [spend({ cost: 5 })])).toBe(false)
    expect(withinAllocation(allocation({ timeLimitMs: 1000 }), [spend({ at: '2026-01-01T00:05:00.000Z' })])).toBe(false)
    expect(withinAllocation(allocation({ parallelism: 1 }), [spend({ parallelism: 4 })])).toBe(false)
    expect(withinAllocation(allocation({ maxCost: 4, timeLimitMs: 1000, parallelism: 1 }), [spend()])).toBe(true)
    expect(withinAllocation(allocation({ maxCost: 4 }), [spend({ cost: 4 })])).toBe(true)
  })
})

describe('recordedTotal', () => {
  it('totals a dimension only when every spend records it', () => {
    expect(recordedTotal([], record => record.cost)).toBeNull()
    expect(recordedTotal([spend({ cost: 2 }), spend({ cost: 3 })], record => record.cost)).toBe(5)
    expect(recordedTotal([spend({ cost: 2 }), spend()], record => record.cost)).toBeNull()
  })
})

describe('halvingRounds', () => {
  it('halves the evaluated count every round and keeps at least one', () => {
    const rounds = halvingRounds(100, 0.5, 3)
    expect(rounds).toEqual([
      { round: 1, evaluateCount: 100, keepCount: 50 },
      { round: 2, evaluateCount: 50, keepCount: 25 },
      { round: 3, evaluateCount: 25, keepCount: 12 },
    ])
  })

  it('never lets the keep count drop below one', () => {
    const rounds = halvingRounds(3, 0.5, 4)
    expect(rounds[0]).toEqual({ round: 1, evaluateCount: 3, keepCount: 1 })
    expect(rounds[1]).toEqual({ round: 2, evaluateCount: 1, keepCount: 1 })
    expect(rounds[3]?.evaluateCount).toBe(1)
  })
})

describe('budgetAllocationRow', () => {
  it('opens a committed record written before §37 added its dimensions', () => {
    const aged: BudgetAllocation = {
      batchId: 'b1',
      taskClass: 'writer',
      candidateClass: 'standard',
      maxTokens: 20000,
      maxWallTimeMs: 600000,
      reason: 'class \'standard\' gets ×1 budget (20000 → 20000 tokens, 600000 → 600000 ms)',
      at: '2026-01-01T00:00:00.000Z',
    }
    expect(budgetAllocationRow.safeParse(aged).success).toBe(true)
    // The dimensions such a record carries no ceiling for stay unmeasured.
    const settlement = settle(aged, [])
    expect(settlement.cost).toEqual({ budgeted: null, spent: null, remaining: null, exceeded: null })
    expect(settlement.time.budgeted).toBeNull()
    expect(settlement.parallelism.budgeted).toBeNull()
  })

  it('accepts the priced dimensions and rejects a class outside the four', () => {
    const row = { ...allocation({ maxCost: 10, timeLimitMs: 1000, parallelism: 4 }) }
    expect(budgetAllocationRow.safeParse(row).success).toBe(true)
    expect(budgetAllocationRow.safeParse({ ...row, candidateClass: 'titanic' }).success).toBe(false)
  })
})

describe('screeningSchedule', () => {
  it('derives the survivors of each round from the recorded pool', () => {
    const pool = Array.from({ length: 100 }, (_, index) => pooled(`c${index}`))
    expect(screeningSchedule(pool, 0.5, 3)).toEqual({
      entered: 100,
      rounds: [
        { round: 1, evaluateCount: 100, keepCount: 50 },
        { round: 2, evaluateCount: 50, keepCount: 25 },
        { round: 3, evaluateCount: 25, keepCount: 12 },
      ],
      finalists: 12,
    })
  })

  it('names no finalists for a pool of nothing', () => {
    expect(screeningSchedule([], 0.5, 3)).toEqual({ entered: 0, rounds: [], finalists: 0 })
  })

  it('names no finalists when the schedule holds no round', () => {
    expect(screeningSchedule([pooled('c1')], 0.5, 0)).toEqual({ entered: 1, rounds: [], finalists: 0 })
  })
})
