/**
 * What one promotion records: the verdict its two arms' measurements support
 * and the evaluation context both arms were measured under. Pure, so specs
 * drive the arithmetic without a run.
 */
import { describe, expect, it } from 'vitest'
import type { SkillScore } from '@deepseek-ai/dsh-evolution-scorer'
import { attemptsPerScenario, measuredOutcome, promotionContext } from '../src/lineage.ts'

/** One aggregated triple over the given scenario records. */
function score(
  records: readonly { scenario: string; fixtureDigest: string; samples: readonly number[] }[],
): SkillScore {
  return {
    skill: 'writer',
    pass: true,
    tokens: 10,
    wallTimeMs: 10,
    scores: records.map(record => ({
      scenario: record.scenario,
      pass: true,
      changes: [],
      tokens: 10,
      wallTimeMs: 10,
      samples: record.samples,
      fixtureDigest: record.fixtureDigest,
      trajectory: null,
    })),
  }
}

const OPTIONS = { scorerVersion: 1, model: 'profile:writer', budget: { tokens: 0, wallTimeMs: 0 } }

describe('attemptsPerScenario', () => {
  it('reports the fewest attempts any scored scenario took', () => {
    expect(attemptsPerScenario(score([
      { scenario: 's1', fixtureDigest: 'd1', samples: [1, 2, 3] },
      { scenario: 's2', fixtureDigest: 'd2', samples: [1] },
    ]))).toBe(1)
  })

  it('reports zero for a triple that scored no scenario', () => {
    expect(attemptsPerScenario(score([]))).toBe(0)
  })
})

describe('promotionContext', () => {
  const baseline = score([{ scenario: 's1', fixtureDigest: 'd1', samples: [1] }])
  const winner = score([{ scenario: 's1', fixtureDigest: 'd1', samples: [1, 2, 3] }])

  it('shares one context when both arms were measured under it', () => {
    const check = promotionContext(baseline, winner, OPTIONS)
    expect(check.mismatch).toEqual([])
    expect(check.context).toMatchObject({
      model: 'profile:writer',
      budget: { tokens: 0, wallTimeMs: 0 },
      tasks: ['s1'],
      attempts: { baseline: 1, winner: 3 },
    })
    expect(check.context.benchmark).toMatch(/^scorer-v1:[0-9a-f]{64}$/)
  })

  it('is order-independent on the scenario records', () => {
    const two = [['s1', 'd1'], ['s2', 'd2']] as const
    const forward = score(two.map(([scenario, fixtureDigest]) => ({ scenario, fixtureDigest, samples: [1] })))
    const backward = score([...two].reverse().map(([scenario, fixtureDigest]) => ({ scenario, fixtureDigest, samples: [1] })))
    // The task set is scored order, so a reorder is a different task set while
    // the benchmark both arms were read from is the same.
    const check = promotionContext(forward, backward, OPTIONS)
    expect(check.mismatch).toEqual(['tasks'])
  })

  it('names a regenerated corpus as a different benchmark', () => {
    const regenerated = score([{ scenario: 's1', fixtureDigest: 'd2', samples: [1] }])
    expect(promotionContext(baseline, regenerated, OPTIONS).mismatch).toEqual(['benchmark'])
    // The scorer's semantics are part of the identity — a version that measures
    // differently is a different benchmark — but both arms are always measured
    // by the mounted scorer, so the version alone never makes them disagree.
    const otherScorer = promotionContext(baseline, winner, { ...OPTIONS, scorerVersion: 2 })
    expect(otherScorer.mismatch).toEqual([])
    expect(otherScorer.context.benchmark).not.toBe(promotionContext(baseline, winner, OPTIONS).context.benchmark)
  })

  it('names both dimensions when the arms differ on both', () => {
    const other = score([
      { scenario: 's2', fixtureDigest: 'd2', samples: [1] },
      { scenario: 's3', fixtureDigest: 'd3', samples: [1] },
    ])
    expect(promotionContext(baseline, other, OPTIONS).mismatch).toEqual(['benchmark', 'tasks'])
  })
})

describe('measuredOutcome', () => {
  it('names the verdict the measured pass states support', () => {
    expect(measuredOutcome({ pass: false }, { pass: true })).toBe('improved')
    expect(measuredOutcome({ pass: true }, { pass: true })).toBe('inconclusive')
    expect(measuredOutcome({ pass: true }, { pass: false })).toBe('regressed')
  })

  it('reads a cost-only win as inconclusive rather than improved', () => {
    // The pass state is the first selection axis (S9.3); fewer tokens is not a
    // pass improvement the envelope may claim.
    const baseline = { pass: true, tokens: 90, wallTimeMs: 400 }
    const winner = { pass: true, tokens: 10, wallTimeMs: 900 }
    expect(measuredOutcome(baseline, winner)).toBe('inconclusive')
  })
})
