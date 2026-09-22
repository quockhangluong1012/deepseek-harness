import { describe, expect, it } from 'vitest'
import { headOf, lineageChain, nextGeneration, rankElite } from '../src/population.ts'
import type { PopulationCandidate } from '../src/types.ts'

const candidate = (overrides: Partial<PopulationCandidate>): PopulationCandidate => ({
  candidateId: 'c1',
  skill: 'writer',
  parentCandidateId: null,
  operator: 'rewrite',
  generation: 1,
  novelty: 0.5,
  triple: { pass: true, tokens: 10, wallTimeMs: 100 },
  status: 'staged',
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('nextGeneration', () => {
  it('starts a skill at generation 1 and advances past the highest', () => {
    expect(nextGeneration([], 'writer')).toBe(1)
    const rows = [
      candidate({ candidateId: 'a', generation: 2 }),
      candidate({ candidateId: 'b', generation: 5 }),
      candidate({ candidateId: 'c', generation: 1 }),
    ]
    expect(nextGeneration(rows, 'writer')).toBe(6)
  })

  it('ignores other skills and stale generations on the running max', () => {
    const rows = [
      candidate({ candidateId: 'a', skill: 'reader', generation: 9 }),
      candidate({ candidateId: 'b', generation: 3 }),
    ]
    expect(nextGeneration(rows, 'writer')).toBe(4)
  })
})

describe('lineageChain', () => {
  it('walks parent links oldest first', () => {
    const rows = [
      candidate({ candidateId: 'a', generation: 1 }),
      candidate({ candidateId: 'b', parentCandidateId: 'a', generation: 2 }),
      candidate({ candidateId: 'c', parentCandidateId: 'b', generation: 3 }),
      candidate({ candidateId: 'other', parentCandidateId: 'a', generation: 2 }),
    ]
    expect(lineageChain(rows, 'c').map(entry => entry.candidateId)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty chain for an unknown id', () => {
    expect(lineageChain([candidate({ candidateId: 'a' })], 'ghost')).toEqual([])
  })

  it('stops at a dangling parent and never loops on a cycle', () => {
    const dangling = [
      candidate({ candidateId: 'a', parentCandidateId: 'missing' }),
    ]
    expect(lineageChain(dangling, 'a').map(entry => entry.candidateId)).toEqual(['a'])
    const cycle = [
      candidate({ candidateId: 'a', parentCandidateId: 'b' }),
      candidate({ candidateId: 'b', parentCandidateId: 'a' }),
      candidate({ candidateId: 'c', parentCandidateId: 'b' }),
    ]
    expect(lineageChain(cycle, 'c').map(entry => entry.candidateId)).toEqual(['a', 'b', 'c'])
  })
})

describe('headOf', () => {
  it('returns undefined for a skill without candidates and ignores other skills', () => {
    const rows = [candidate({ candidateId: 'a', skill: 'reader' })]
    expect(headOf(rows, 'writer')).toBeUndefined()
    expect(headOf([], 'writer')).toBeUndefined()
  })

  it('prefers the highest generation and breaks ties by newest at', () => {
    const rows = [
      candidate({ candidateId: 'old', generation: 2, at: '2026-01-01T00:00:00.000Z' }),
      candidate({ candidateId: 'new', generation: 2, at: '2026-01-02T00:00:00.000Z' }),
      candidate({ candidateId: 'gen3', generation: 3, at: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(headOf(rows, 'writer')?.candidateId).toBe('gen3')
    const tied = rows.slice(0, 2)
    expect(headOf(tied, 'writer')?.candidateId).toBe('new')
  })
})

describe('rankElite', () => {
  const rows = [
    candidate({ candidateId: 'slow', status: 'approved', triple: { pass: true, tokens: 10, wallTimeMs: 500 } }),
    candidate({ candidateId: 'fast', status: 'approved', triple: { pass: true, tokens: 10, wallTimeMs: 100 } }),
    candidate({ candidateId: 'cheap', status: 'approved', triple: { pass: true, tokens: 5, wallTimeMs: 900 } }),
    candidate({ candidateId: 'fail', status: 'approved', triple: { pass: false, tokens: 1, wallTimeMs: 1 } }),
    candidate({ candidateId: 'staged', status: 'staged', triple: { pass: true, tokens: 1, wallTimeMs: 1 } }),
    candidate({ candidateId: 'other-skill', skill: 'reader', status: 'approved', triple: { pass: true, tokens: 1, wallTimeMs: 1 } }),
  ]

  it('ranks approved candidates by pass, then tokens, then wall time', () => {
    expect(rankElite(rows, 'writer').map(entry => entry.candidateId))
      .toEqual(['cheap', 'fast', 'slow', 'fail'])
  })

  it('ranks unmeasured candidates below every measured one', () => {
    const mixed = [
      candidate({ candidateId: 'unmeasured', status: 'approved', triple: null }),
      candidate({ candidateId: 'measured', status: 'approved', triple: { pass: false, tokens: 1, wallTimeMs: 1 } }),
      candidate({ candidateId: 'unmeasured2', status: 'approved', triple: null }),
    ]
    expect(rankElite(mixed, 'writer').map(entry => entry.candidateId))
      .toEqual(['measured', 'unmeasured', 'unmeasured2'])
  })

  it('returns an empty elite when nothing is approved', () => {
    expect(rankElite([candidate({ candidateId: 'a', status: 'rejected' })], 'writer')).toEqual([])
  })
})
