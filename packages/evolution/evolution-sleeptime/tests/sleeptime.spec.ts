import { describe, expect, it } from 'vitest'
import { PRECOMPUTE_KINDS, decideWorth, expectedNet, planFor, savingsOf } from '../src/sleeptime.ts'
import type { AnticipatedTask } from '../src/types.ts'

const task = (overrides: Partial<AnticipatedTask> = {}): AnticipatedTask => ({
  taskId: 't1',
  domain: 'writer',
  likelihood: 0.5,
  expectedQueries: 10,
  expectedSavingTokens: 100,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('PRECOMPUTE_KINDS', () => {
  it('lists the three canonical precompute kinds', () => {
    expect([...PRECOMPUTE_KINDS]).toEqual(['summary', 'retrieval-index', 'candidate-plan'])
  })
})

describe('expectedNet', () => {
  it('weights the savings by likelihood and subtracts the offline cost', () => {
    // 0.5 × 10 × 100 − 200 = 300.
    expect(expectedNet(task(), 200)).toBe(300)
  })

  it('reports a negative net when the cost dominates', () => {
    expect(expectedNet(task(), 2000)).toBe(-1500)
  })

  it('spends the full cost on a task that never materializes', () => {
    expect(expectedNet(task({ likelihood: 0 }), 200)).toBe(-200)
  })

  it('costs nothing at zero estimated cost', () => {
    expect(expectedNet(task({ likelihood: 1 }), 0)).toBe(1000)
  })
})

describe('decideWorth', () => {
  it('is worth it on a positive net and names the numbers', () => {
    const decision = decideWorth(task(), 200)
    expect(decision).toMatchObject({ taskId: 't1', domain: 'writer', worthIt: true, expectedNet: 300 })
    expect(decision.reason).toBe('net 300 tokens (likelihood 0.5 × 10 queries × 100 saved − cost 200)')
  })

  it('is not worth it on a zero net: idle time spent for nothing', () => {
    // 0.5 × 10 × 100 − 500 = 0 exactly.
    const decision = decideWorth(task(), 500)
    expect(decision.worthIt).toBe(false)
    expect(decision.expectedNet).toBe(0)
    expect(decision.reason).toContain('net 0 tokens')
  })

  it('is not worth it on a negative net', () => {
    const decision = decideWorth(task(), 2000)
    expect(decision).toMatchObject({ worthIt: false, expectedNet: -1500 })
    expect(decision.reason).toContain('cost 2000')
  })
})

describe('planFor', () => {
  it('orders worth-it decisions best net first and drops the rest', () => {
    const rows = [
      task({ taskId: 'cheap', likelihood: 0.5, expectedQueries: 10, expectedSavingTokens: 100 }),
      task({ taskId: 'rich', likelihood: 1, expectedQueries: 10, expectedSavingTokens: 100 }),
      task({ taskId: 'poor', likelihood: 0.01, expectedQueries: 1, expectedSavingTokens: 10 }),
    ]
    const planned = planFor(rows, 200, 100_000)
    expect(planned.map(decision => decision.taskId)).toEqual(['rich', 'cheap'])
    expect(planned.every(decision => decision.worthIt)).toBe(true)
  })

  it('breaks net ties by task id', () => {
    const rows = [
      task({ taskId: 'b', likelihood: 0.5 }),
      task({ taskId: 'a', likelihood: 0.5 }),
    ]
    const planned = planFor(rows, 200, 100_000)
    expect(planned.map(decision => decision.taskId)).toEqual(['a', 'b'])
  })

  it('fits greedily into the budget and skips what overflows', () => {
    const rows = [
      task({ taskId: 'first', likelihood: 1 }),
      task({ taskId: 'second', likelihood: 0.9 }),
      task({ taskId: 'third', likelihood: 0.8 }),
    ]
    // One precompute costs 200, so a budget of 450 fits two.
    const planned = planFor(rows, 200, 450)
    expect(planned.map(decision => decision.taskId)).toEqual(['first', 'second'])
  })

  it('plans nothing when the budget cannot fit one precompute', () => {
    expect(planFor([task()], 200, 199)).toEqual([])
  })

  it('plans nothing when no task is worth it', () => {
    expect(planFor([task({ likelihood: 0 })], 200, 100_000)).toEqual([])
  })
})

describe('savingsOf', () => {
  it('subtracts the offline cost from the saved tokens', () => {
    expect(savingsOf({ savedTokens: 900, offlineCostTokens: 200 })).toBe(700)
  })

  it('stays negative while the precompute has not paid back', () => {
    expect(savingsOf({ savedTokens: 50, offlineCostTokens: 200 })).toBe(-150)
  })
})
