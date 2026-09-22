import { describe, expect, it } from 'vitest'
import {
  DREAM_WEIGHTS,
  FREQUENCY_HALF_POINT,
  conceptOverlap,
  countConcepts,
  scoreCandidate,
} from '../src/signals.ts'
import type { CandidateEvidence } from '../src/signals.ts'

const NOW = Date.parse('2026-09-13T00:00:00.000Z')

function evidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    relevance: 0,
    count: 0,
    sessions: 0,
    firstAt: new Date(NOW).toISOString(),
    lastAt: new Date(NOW).toISOString(),
    concepts: 0,
    now: NOW,
    ...overrides,
  }
}

describe('dreaming signals', () => {
  it('weights sum to one so a perfect candidate scores one', () => {
    const total = Object.values(DREAM_WEIGHTS).reduce((sum, weight) => sum + weight, 0)
    expect(total).toBeCloseTo(1, 10)
    const perfect = scoreCandidate(evidence({
      relevance: 1,
      count: 1000,
      sessions: 1000,
      firstAt: new Date(NOW - 30 * 86_400_000).toISOString(),
      concepts: 100,
    }))
    expect(perfect.score).toBeGreaterThan(0.99)
    expect(perfect.signals.integration).toBe(1)
    expect(perfect.signals.conceptRichness).toBe(1)
  })

  it('scores a candidate with no evidence at zero apart from its freshness', () => {
    const stale = scoreCandidate(evidence({ lastAt: new Date(NOW - 3650 * 86_400_000).toISOString() }))
    expect(stale.score).toBeLessThan(0.001)
    expect(scoreCandidate(evidence()).signals.recency).toBe(1)
  })

  it('saturates frequency at the half point instead of growing without bound', () => {
    const atHalf = scoreCandidate(evidence({ count: FREQUENCY_HALF_POINT, relevance: 1 }))
    expect(atHalf.signals.frequency).toBeCloseTo(0.5, 10)
    const loud = scoreCandidate(evidence({ count: 100_000, relevance: 1 }))
    expect(loud.signals.frequency).toBeLessThan(1)
  })

  it('halves recency every thirty days', () => {
    const fresh = scoreCandidate(evidence({ relevance: 1 }))
    const month = scoreCandidate(evidence({
      lastAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    }))
    expect(month.signals.recency).toBeCloseTo(fresh.signals.recency / 2, 10)
  })

  it('treats a future timestamp as maximally fresh', () => {
    expect(scoreCandidate(evidence({ lastAt: new Date(NOW + 86_400_000).toISOString() })).signals.recency)
      .toBe(1)
  })

  it('raises integration with the span it stayed observed and caps at a week', () => {
    const sameDay = scoreCandidate(evidence())
    expect(sameDay.signals.integration).toBe(0)
    const week = scoreCandidate(evidence({ firstAt: new Date(NOW - 7 * 86_400_000).toISOString() }))
    expect(week.signals.integration).toBe(1)
  })

  it('clamps a similarity a caller passes outside the unit interval', () => {
    expect(scoreCandidate(evidence({ relevance: 5 })).signals.relevance).toBe(1)
    expect(scoreCandidate(evidence({ relevance: -5 })).signals.relevance).toBe(0)
  })

  it('counts distinct concepts and ignores one-character words', () => {
    expect(countConcepts('the disk is full, the disk is full')).toBe(4)
    expect(countConcepts('a b c')).toBe(0)
    expect(countConcepts('')).toBe(0)
  })

  it('measures overlap as the shared share of two texts concepts', () => {
    expect(conceptOverlap('disk full cache', 'disk full')).toBeCloseTo(2 / 3, 10)
  })

  it('reads no overlap when either text carries no comparable concept', () => {
    expect(conceptOverlap('x y z', 'disk full')).toBe(0)
    expect(conceptOverlap('disk full', 'x y z')).toBe(0)
    expect(conceptOverlap('', '')).toBe(0)
  })
})
