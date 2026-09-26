import { describe, expect, it } from 'vitest'
import type { ScoreRecord, SkillScore } from '@deepseek-ai/dsh-evolution-scorer'
import { pairedSignTest } from '../src/significance.ts'

function record(scenario: string, pass: boolean): ScoreRecord {
  return {
    scenario,
    pass,
    changes: [],
    tokens: 10,
    wallTimeMs: 5,
    samples: [5],
    fixtureDigest: 'digest',
    trajectory: null,
  }
}

function score(scores: readonly ScoreRecord[]): SkillScore {
  return {
    skill: 'writer',
    pass: scores.every(entry => entry.pass),
    tokens: scores.length * 10,
    wallTimeMs: scores.length * 5,
    scores,
  }
}

describe('pairedSignTest', () => {
  it('counts a scenario the winner passed and the baseline failed as a win', () => {
    const result = pairedSignTest(
      score([record('s1', false), record('s2', true)]),
      score([record('s1', true), record('s2', true)]),
      0.95,
    )
    expect(result).toMatchObject({ method: 'paired-sign-test', wins: 1, losses: 0, ties: 1, confidence: 0.95 })
    expect(result.pValue).toBeCloseTo(1, 10)
    expect(result.significant).toBe(false)
  })

  it('decides the boundary case by the configured confidence', () => {
    const baseline = score([0, 1, 2, 3, 4].map(index => record(`s${index}`, false)))
    const winner = score([0, 1, 2, 3, 4].map(index => record(`s${index}`, true)))
    // Five discordant pairs all favoring the winner: p = 2/2^5 = 0.0625.
    expect(pairedSignTest(baseline, winner, 0.95).pValue).toBeCloseTo(0.0625, 10)
    expect(pairedSignTest(baseline, winner, 0.95).significant).toBe(false)
    expect(pairedSignTest(baseline, winner, 0.9).significant).toBe(true)
  })

  it('clears the bar when the discordant pairs are lopsided enough', () => {
    const baseline = score([0, 1, 2, 3, 4, 5].map(index => record(`s${index}`, false)))
    const winner = score([0, 1, 2, 3, 4, 5].map(index => record(`s${index}`, true)))
    const result = pairedSignTest(baseline, winner, 0.95)
    expect(result.wins).toBe(6)
    expect(result.pValue).toBeCloseTo(0.03125, 10)
    expect(result.significant).toBe(true)
  })

  it('reports no significance for a split that favors neither arm', () => {
    const result = pairedSignTest(
      score([record('s1', true), record('s2', false)]),
      score([record('s1', false), record('s2', true)]),
      0.95,
    )
    expect(result).toMatchObject({ wins: 1, losses: 1, ties: 0 })
    expect(result.pValue).toBe(1)
    expect(result.significant).toBe(false)
  })

  it('reports no significance when every paired scenario agrees', () => {
    const result = pairedSignTest(
      score([record('s1', true), record('s2', false)]),
      score([record('s1', true), record('s2', false)]),
      0.5,
    )
    expect(result).toMatchObject({ wins: 0, losses: 0, ties: 2, pValue: 1, significant: false })
  })

  it('leaves a scenario only one arm scored out of the tally', () => {
    const result = pairedSignTest(
      score([record('s1', false)]),
      score([record('s1', true), record('s2', true)]),
      0.95,
    )
    expect(result).toMatchObject({ wins: 1, losses: 0, ties: 0 })
  })
})
