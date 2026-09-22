import { describe, expect, it } from 'vitest'
import { archiveNovelty, noveltyMean, similarity } from '../src/novelty.ts'
import type { NoveltyArchiveEntry } from '../src/types.ts'

const entry = (overrides: Partial<NoveltyArchiveEntry>): NoveltyArchiveEntry => ({
  candidateId: 'c1',
  skill: 'writer',
  features: ['a', 'b'],
  novelty: 0.5,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('similarity', () => {
  it('reports zero for two empty sets and full overlap for identical sets', () => {
    expect(similarity([], [])).toBe(0)
    expect(similarity(['a', 'b'], ['b', 'a'])).toBe(1)
  })

  it('measures the shared share of two sets', () => {
    expect(similarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(2 / 4)
    expect(similarity(['a', 'b'], ['c', 'd'])).toBe(0)
    expect(similarity([], ['a'])).toBe(0)
  })
})

describe('archiveNovelty', () => {
  it('reports one for the seed entry of an empty archive', () => {
    expect(archiveNovelty(['a', 'b'], [])).toBe(1)
  })

  it('reports zero for a descriptor with no features', () => {
    expect(archiveNovelty([], [entry()])).toBe(0)
  })

  it('measures one minus the maximum similarity to any entry', () => {
    const archive = [
      entry({ candidateId: 'x', features: ['a', 'b', 'c'] }),
      entry({ candidateId: 'y', features: ['p', 'q'] }),
    ]
    // Max similarity is 1/2 against 'x' and 1/2 against 'y', so novelty is 1/2.
    expect(archiveNovelty(['a', 'b', 'd'], archive)).toBeCloseTo(1 / 2)
    expect(archiveNovelty(['p'], archive)).toBeCloseTo(1 / 2)
    // A descriptor already archived verbatim is not novel at all.
    expect(archiveNovelty(['a', 'b', 'c'], archive)).toBe(0)
  })
})

describe('noveltyMean', () => {
  it('reports zero for an empty archive', () => {
    expect(noveltyMean([])).toBe(0)
  })

  it('averages the recorded novelties', () => {
    const archive = [
      entry({ candidateId: 'x', novelty: 1 }),
      entry({ candidateId: 'y', novelty: 0.5 }),
      entry({ candidateId: 'z', novelty: 0 }),
    ]
    expect(noveltyMean(archive)).toBeCloseTo(0.5)
  })
})
