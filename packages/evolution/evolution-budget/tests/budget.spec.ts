import { describe, expect, it } from 'vitest'
import { buildAllocation, CANDIDATE_CLASSES, halvingRounds, multiplierFor, settle, withinAllocation } from '../src/budget.ts'
import type { AllocationInput, BudgetAllocation, SpendRecord } from '../src/types.ts'

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
})

describe('withinAllocation', () => {
  it('is true inside both ceilings and false past either', () => {
    expect(withinAllocation(allocation(), [spend()])).toBe(true)
    expect(withinAllocation(allocation({ maxTokens: 4000 }), [spend()])).toBe(false)
    expect(withinAllocation(allocation({ maxWallTimeMs: 30000 }), [spend()])).toBe(false)
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