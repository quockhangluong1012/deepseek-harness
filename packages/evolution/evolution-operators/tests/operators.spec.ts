import { describe, expect, it } from 'vitest'
import { MUTATION_OPERATORS, rankOperators, recommendOperator, scoreOf, statsKey, updatedStats } from '../src/operators.ts'
import type { OperatorOutcome, OperatorStats } from '../src/types.ts'

const outcome = (overrides: Partial<OperatorOutcome> = {}): OperatorOutcome => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
  ...overrides,
})

const stats = (overrides: Partial<OperatorStats> = {}): OperatorStats => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  attempts: 3,
  accepted: 2,
  meanDelta: 0.5,
  regressionRate: 1 / 3,
  lastAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('MUTATION_OPERATORS', () => {
  it('lists the eight canonical mutation operators in order', () => {
    expect([...MUTATION_OPERATORS]).toEqual([
      'rewrite',
      'add-step',
      'remove-step',
      'change-tool',
      'change-retrieval',
      'change-evaluator',
      'merge-candidates',
      'adversarial-patch',
    ])
  })
})

describe('statsKey', () => {
  it('joins operator and artifact class with a separator', () => {
    expect(statsKey('change-tool', 'writer')).toBe('change-tool\0writer')
  })
})

describe('updatedStats', () => {
  it('creates the first statistics row from one outcome', () => {
    const row = updatedStats(undefined, outcome(), '2026-01-01T00:00:00.000Z')
    expect(row).toMatchObject({ operator: 'rewrite', artifactClass: 'writer', attempts: 1, accepted: 1, meanDelta: 1 })
    expect(row.meanDelta).toBe(1)
    expect(row.regressionRate).toBe(0)
    expect(row.lastAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('accumulates attempts and acceptance across outcomes', () => {
    const first = updatedStats(undefined, outcome(), '2026-01-01T00:00:00.000Z')
    const second = updatedStats(first, outcome({ accepted: false }), '2026-01-02T00:00:00.000Z')
    expect(second).toMatchObject({ attempts: 2, accepted: 1 })
  })

  it('keeps the running mean delta exact', () => {
    let row = updatedStats(undefined, outcome({ delta: 1 }), '2026-01-01T00:00:00.000Z')
    row = updatedStats(row, outcome({ delta: -1 }), '2026-01-02T00:00:00.000Z')
    expect(row.meanDelta).toBeCloseTo(0, 10)
    row = updatedStats(row, outcome({ delta: 1 }), '2026-01-03T00:00:00.000Z')
    expect(row.meanDelta).toBeCloseTo(1 / 3, 10)
  })

  it('counts the regression rate as the exact share of negative deltas', () => {
    let row = updatedStats(undefined, outcome({ delta: -1 }), '2026-01-01T00:00:00.000Z')
    row = updatedStats(row, outcome({ delta: 1 }), '2026-01-02T00:00:00.000Z')
    row = updatedStats(row, outcome({ delta: -1 }), '2026-01-03T00:00:00.000Z')
    expect(row.regressionRate).toBeCloseTo(2 / 3, 10)
  })
})

describe('scoreOf', () => {
  it('scores an untried operator at its prior plus the full exploration bonus', () => {
    expect(scoreOf(undefined, 0.2)).toBeCloseTo(0.7, 10)
  })

  it('lets a proven operator outrank an untried one', () => {
    const proven = stats({ attempts: 10, accepted: 8 })
    expect(scoreOf(proven, 0.2)).toBeGreaterThan(scoreOf(undefined, 0.2))
  })

  it('lets an untried operator outrank a failing one', () => {
    const failing = stats({ attempts: 10, accepted: 2 })
    expect(scoreOf(undefined, 0.2)).toBeGreaterThan(scoreOf(failing, 0.2))
  })

  it('scores nothing below its prior when exploration is zero', () => {
    expect(scoreOf(undefined, 0)).toBeCloseTo(0.5, 10)
  })
})

describe('rankOperators', () => {
  it('ranks all eight canonical operators for the class', () => {
    const ranked = rankOperators([], 'writer', 0.2)
    expect(ranked.map(entry => entry.operator)).toHaveLength(8)
  })

  it('admits an observed deployment-specific operator into the ranking', () => {
    const row = stats({ operator: 'custom-x', attempts: 6, accepted: 5, meanDelta: 0.8, regressionRate: 0 })
    const ranked = rankOperators([row], 'writer', 0.2)
    const entry = ranked.find(item => item.operator === 'custom-x')
    expect(entry).toBeDefined()
    // A well-accepted deployment operator leads the canonical priors.
    expect(ranked[0]?.operator).toBe('custom-x')
    expect(ranked).toHaveLength(9)
  })

  it('breaks equal untried scores by canonical order', () => {
    const ranked = rankOperators([], 'writer', 0.2)
    expect(ranked[0]?.operator).toBe('rewrite')
    expect(ranked.map(entry => entry.operator)).toEqual([...MUTATION_OPERATORS])
  })

  it('ranks a proven accepted operator first with an untried prior behind it', () => {
    const row = stats({ operator: 'change-tool', attempts: 10, accepted: 9, meanDelta: 0.8, regressionRate: 0.1 })
    const ranked = rankOperators([row], 'writer', 0.2)
    expect(ranked[0]?.operator).toBe('change-tool')
    expect(ranked[0]?.acceptanceRate).toBeCloseTo(0.9, 10)
    expect(ranked[1]?.operator).toBe('rewrite')
  })

  it('demotes a failing operator below the untried priors', () => {
    const row = stats({ operator: 'rewrite', attempts: 8, accepted: 1, meanDelta: -0.5, regressionRate: 0.5 })
    const ranked = rankOperators([row], 'writer', 0.2)
    expect(ranked[0]?.operator).not.toBe('rewrite')
    expect(ranked.find(entry => entry.operator === 'rewrite')?.score).toBeLessThan(ranked[0]?.score ?? 0)
  })

  it('names the numbers in the reason for proven and untried operators', () => {
    const row = stats({ operator: 'rewrite', attempts: 4, accepted: 3, meanDelta: 0.5, regressionRate: 0.25 })
    const ranked = rankOperators([row], 'writer', 0.2)
    const proven = ranked.find(entry => entry.operator === 'rewrite')
    expect(proven?.reason).toContain('accepted 3/4')
    expect(proven?.reason).toContain('mean delta 0.50')
    const untried = ranked.find(entry => entry.operator === 'adversarial-patch')
    expect(untried?.reason).toContain("untried on 'writer'")
  })
})

describe('recommendOperator', () => {
  it('returns the top of the ranking', () => {
    const ranked = rankOperators([stats({ operator: 'merge-candidates', attempts: 6, accepted: 5 })], 'writer', 0.2)
    expect(recommendOperator(ranked)?.operator).toBe('merge-candidates')
  })

  it('yields undefined for an empty ranking', () => {
    expect(recommendOperator([])).toBeUndefined()
  })
})