/**
 * Pareto selection over measured triples: dominance, the nondominated
 * frontier, and the winner that must beat the re-scored baseline.
 */
import { describe, expect, it } from 'vitest'
import { dominates, paretoFrontier, pickWinner, screenSurvivors } from '../src/pareto.ts'
import type { EvaluatedVariant } from '../src/types.ts'

function variant(index: number, pass: boolean, tokens: number, wallTimeMs: number, novelty = 0): EvaluatedVariant {
  return {
    index,
    body: `variant ${index}`,
    operator: 'rewrite',
    novelty,
    score: { skill: 'writer', pass, tokens, wallTimeMs, scores: [] },
  }
}

describe('dominates', () => {
  it('lets a pass dominate a failure regardless of cost', () => {
    expect(dominates({ pass: true, tokens: 999, wallTimeMs: 999 }, { pass: false, tokens: 1, wallTimeMs: 1 })).toBe(true)
    expect(dominates({ pass: false, tokens: 1, wallTimeMs: 1 }, { pass: true, tokens: 999, wallTimeMs: 999 })).toBe(false)
  })

  it('requires a strict improvement on one axis at equal pass', () => {
    expect(dominates({ pass: true, tokens: 5, wallTimeMs: 5 }, { pass: true, tokens: 5, wallTimeMs: 5 })).toBe(false)
    expect(dominates({ pass: true, tokens: 4, wallTimeMs: 5 }, { pass: true, tokens: 5, wallTimeMs: 5 })).toBe(true)
    expect(dominates({ pass: true, tokens: 6, wallTimeMs: 5 }, { pass: true, tokens: 5, wallTimeMs: 5 })).toBe(false)
  })
})

describe('paretoFrontier', () => {
  it('keeps only the nondominated members in input order', () => {
    const cheap = variant(0, true, 3, 9)
    const fast = variant(1, true, 9, 3)
    const dominated = variant(2, true, 9, 9)
    expect(paretoFrontier([dominated, cheap, fast]).map(member => member.index)).toEqual([0, 1])
  })

  it('returns the empty frontier for no candidates', () => {
    expect(paretoFrontier([])).toEqual([])
  })
})

describe('screenSurvivors', () => {
  it('keeps the best-screened variants and returns them in mutation order', () => {
    const survivors = screenSurvivors(
      [variant(0, true, 30, 5), variant(1, true, 10, 5), variant(2, true, 20, 5)],
      2,
    )
    expect(survivors.map(member => member.index)).toEqual([1, 2])
  })

  it('ranks a pass ahead of a cheaper failure and novelty ahead of wall time at equal cost', () => {
    expect(screenSurvivors([variant(0, false, 1, 1), variant(1, true, 99, 99)], 1).map(member => member.index)).toEqual([1])
    expect(screenSurvivors([variant(0, true, 5, 9, 0), variant(1, true, 5, 2, 0.4)], 1).map(member => member.index)).toEqual([1])
    expect(screenSurvivors([variant(0, true, 5, 9, 0.4), variant(1, true, 6, 2, 0.9)], 1).map(member => member.index)).toEqual([0])
    expect(screenSurvivors([variant(0, true, 5, 5, 0.4), variant(1, true, 5, 5, 0.4)], 1).map(member => member.index)).toEqual([0])
  })
})

describe('pickWinner', () => {
  it('picks the cheapest frontier member that beats the baseline', () => {
    const baseline = { pass: true, tokens: 10, wallTimeMs: 10 }
    const winner = pickWinner(baseline, [
      variant(0, true, 9, 9),
      variant(1, true, 5, 5),
      variant(2, false, 1, 1),
    ])
    expect(winner?.index).toBe(1)
  })

  it('breaks ties by novelty, then wall time, then earlier mutation', () => {
    const baseline = { pass: true, tokens: 10, wallTimeMs: 10 }
    // Dominance still rules: a faster candidate is not passed over for a novel
    // one. Novelty decides only among candidates that measured the same.
    expect(pickWinner(baseline, [variant(0, true, 5, 4, 0), variant(1, true, 5, 8, 0.5)])?.index).toBe(0)
    const byNovelty = pickWinner(baseline, [variant(0, true, 5, 4, 0), variant(1, true, 5, 4, 0.5)])
    expect(byNovelty?.index).toBe(1)
    const byWall = pickWinner(baseline, [variant(0, true, 5, 8, 0.2), variant(1, true, 5, 4, 0.2)])
    expect(byWall?.index).toBe(1)
    const byIndex = pickWinner(baseline, [variant(0, true, 5, 4, 0.2), variant(1, true, 5, 4, 0.2)])
    expect(byIndex?.index).toBe(0)
  })

  it('prefers a new pass over a cheaper failure', () => {
    const baseline = { pass: false, tokens: 4, wallTimeMs: 4 }
    const winner = pickWinner(baseline, [variant(0, false, 3, 3), variant(1, true, 9, 9)])
    expect(winner?.index).toBe(1)
  })

  it('returns null when nothing dominates the baseline', () => {
    const baseline = { pass: true, tokens: 5, wallTimeMs: 5 }
    expect(pickWinner(baseline, [variant(0, true, 5, 5), variant(1, true, 9, 9)])).toBeNull()
    expect(pickWinner(baseline, [])).toBeNull()
  })
})
