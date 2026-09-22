import { describe, expect, it } from 'vitest'
import { rankStrategies, recommendStrategy, strategyKey, updatedStrategy, weightOf } from '../src/strategy.ts'
import type { EvaluatorOutcome, EvaluatorStrategy } from '../src/types.ts'

const outcome = (overrides: Partial<EvaluatorOutcome> = {}): EvaluatorOutcome => ({
  evaluator: 'scorer-v1',
  taskClass: 'writer',
  verdict: true,
  groundTruth: true,
  independent: true,
  ...overrides,
})

const strategy = (overrides: Partial<EvaluatorStrategy> = {}): EvaluatorStrategy => ({
  evaluator: 'scorer-v1',
  taskClass: 'writer',
  samples: 4,
  independentSamples: 3,
  corroborations: 2,
  weight: 0.6,
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('strategyKey', () => {
  it('joins evaluator and task class with a separator', () => {
    expect(strategyKey('scorer-v1', 'writer')).toBe('scorer-v1\0writer')
  })
})

describe('weightOf', () => {
  it('smooths one corroboration in two independent observations', () => {
    expect(weightOf(2, 3)).toBeCloseTo(0.6, 10)
  })

  it('weighs nothing at all without independent evidence', () => {
    expect(weightOf(5, 0)).toBe(0)
  })

  it('stays positive after a single corroboration', () => {
    expect(weightOf(1, 1)).toBeCloseTo(2 / 3, 10)
  })
})

describe('updatedStrategy', () => {
  it('creates the first statistics row from one independent pair', () => {
    const row = updatedStrategy(undefined, outcome(), '2026-01-01T00:00:00.000Z')
    expect(row).toMatchObject({
      evaluator: 'scorer-v1',
      taskClass: 'writer',
      samples: 1,
      independentSamples: 1,
      corroborations: 1,
    })
    expect(row.weight).toBeCloseTo(2 / 3, 10)
    expect(row.lastAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('counts only independent matching pairs as corroborations', () => {
    let row = updatedStrategy(undefined, outcome(), '2026-01-01T00:00:00.000Z')
    row = updatedStrategy(row, outcome({ verdict: false, groundTruth: false, independent: false }), '2026-01-02T00:00:00.000Z')
    expect(row).toMatchObject({ samples: 2, independentSamples: 1, corroborations: 1 })
    expect(row.weight).toBeCloseTo((1 + 1) / (1 + 2), 10)
  })

  it('records a mismatch as an independent sample without corroboration', () => {
    let row = updatedStrategy(undefined, outcome({ verdict: true, groundTruth: false }), '2026-01-01T00:00:00.000Z')
    expect(row).toMatchObject({ independentSamples: 1, corroborations: 0 })
    expect(row.weight).toBeCloseTo(1 / 3, 10)
  })
})

describe('rankStrategies', () => {
  it('ranks the task class by weight descending with evaluator tie-break', () => {
    const rows = [
      strategy({ evaluator: 'b', weight: 0.7, independentSamples: 5 }),
      strategy({ evaluator: 'a', weight: 0.8, independentSamples: 3 }),
      strategy({ evaluator: 'c', weight: 0.7, independentSamples: 2 }),
    ]
    const ranked = rankStrategies(rows, 'writer')
    expect(ranked.map(entry => entry.evaluator)).toEqual(['a', 'b', 'c'])
  })

  it('ignores other task classes', () => {
    const rows = [strategy(), strategy({ taskClass: 'reader' })]
    expect(rankStrategies(rows, 'writer')).toHaveLength(1)
    expect(rankStrategies([], 'ghost')).toEqual([])
  })

  it('names the corroboration numbers in the reason', () => {
    const ranked = rankStrategies([strategy({ samples: 4, independentSamples: 3, corroborations: 2, weight: 0.6 })], 'writer')
    expect(ranked[0]?.reason).toContain('2/3 independent verdicts corroborated')
    expect(ranked[0]?.reason).toContain('4 verdicts recorded')
    const zero = rankStrategies([strategy({ independentSamples: 0, weight: 0 })], 'writer')
    expect(zero[0]?.reason).toContain('no independent evidence')
  })
})

describe('recommendStrategy', () => {
  it('returns the best-ranked evaluator with enough independent samples', () => {
    const ranked = rankStrategies([
      strategy({ evaluator: 'a', weight: 0.9, independentSamples: 3 }),
      strategy({ evaluator: 'b', weight: 1, independentSamples: 1 }),
    ], 'writer')
    expect(recommendStrategy(ranked, 3)?.evaluator).toBe('a')
  })

  it('yields undefined while no evaluator has enough independent samples', () => {
    const ranked = rankStrategies([strategy({ weight: 0.9, independentSamples: 2 })], 'writer')
    expect(recommendStrategy(ranked, 3)).toBeUndefined()
    expect(recommendStrategy([], 3)).toBeUndefined()
  })
})