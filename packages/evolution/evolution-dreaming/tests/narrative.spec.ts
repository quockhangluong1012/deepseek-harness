import { describe, expect, it } from 'vitest'
import {
  decidePromotion,
  evolveNarratives,
  mergeProvenance,
  narrativeId,
  relateNarrative,
} from '../src/narrative.ts'
import type { NarrativeLimits, QualifiedCandidate } from '../src/narrative.ts'
import type { DreamCandidate, DreamPromotion, DreamProvenance } from '../src/types.ts'

const NOW = '2026-09-13T00:00:00.000Z'

const LIMITS: NarrativeLimits = { mergeOverlap: 0.6, supersedeOverlap: 0.3, maxRestatements: 2 }

const GATE = { minScore: 0.65, minRecallCount: 3, minUniqueQueries: 2 }

/** The canonical statement the relation specs restate and correct. */
const CANONICAL = 'disk total full writing cache'

/** A restatement of {@link CANONICAL}: five of six concepts shared, so 0.83. */
const RESTATED = 'disk total full writing cache local'

/** A correction of {@link CANONICAL}: three of seven concepts shared, so 0.43. */
const CORRECTED = 'disk total full throttled backup'

/** A failure sharing no concept with {@link CANONICAL}. */
const UNRELATED = 'network timeout during signup'

function candidate(overrides: Partial<DreamCandidate> = {}): DreamCandidate {
  return {
    id: narrativeId(overrides.statement ?? CANONICAL),
    statement: CANONICAL,
    tool: 'bash',
    count: 9,
    sessions: 4,
    firstAt: '2026-09-01T00:00:00.000Z',
    lastAt: '2026-09-12T00:00:00.000Z',
    provenance: 'attributed',
    ...overrides,
  }
}

function promotion(overrides: Partial<DreamPromotion> = {}): DreamPromotion {
  const statement = overrides.statement ?? CANONICAL
  return {
    id: narrativeId(statement),
    statement,
    tool: 'bash',
    score: 0.8,
    signals: {
      relevance: 1,
      frequency: 0.5,
      queryDiversity: 0.5,
      recency: 1,
      integration: 1,
      conceptRichness: 0.5,
    },
    promotedAt: NOW,
    evidence: { provenance: 'attributed', count: 9, sessions: 4 },
    restatements: [],
    supersededBy: null,
    supersededAt: null,
    ...overrides,
  }
}

function qualified(overrides: Partial<DreamCandidate> = {}): QualifiedCandidate {
  const held = candidate(overrides)
  return { candidate: held, score: 0.8, signals: promotion().signals }
}

describe('narrative identity', () => {
  it('normalizes case, surrounding space, and runs of space', () => {
    expect(narrativeId('  DISK   is  Full \n')).toBe('disk is full')
  })
})

describe('provenance merge', () => {
  it('keeps attributed provenance when either side was observed', () => {
    expect(mergeProvenance('attributed', 'attributed')).toBe('attributed')
    expect(mergeProvenance('attributed', 'unattributed')).toBe('attributed')
    expect(mergeProvenance('unattributed', 'attributed')).toBe('attributed')
  })

  it('stays unattributed when neither side was observed', () => {
    expect(mergeProvenance('unattributed', 'unattributed')).toBe('unattributed')
  })
})

describe('promotion gate', () => {
  const input = {
    provenance: 'attributed' as DreamProvenance,
    score: 0.9,
    count: 9,
    sessions: 4,
  }

  it('admits a candidate that clears every gate', () => {
    expect(decidePromotion(input, GATE)).toEqual({ promote: true })
  })

  it('refuses an unattributed candidate by name however high it scores', () => {
    expect(decidePromotion({ ...input, provenance: 'unattributed' }, GATE))
      .toEqual({ promote: false, reason: 'unattributed-provenance' })
  })

  it('names the numeric gate that refused a candidate', () => {
    expect(decidePromotion({ ...input, score: 0.5 }, GATE)).toEqual({ promote: false, reason: 'below-score' })
    expect(decidePromotion({ ...input, count: 2 }, GATE)).toEqual({ promote: false, reason: 'below-recall' })
    expect(decidePromotion({ ...input, sessions: 1 }, GATE)).toEqual({ promote: false, reason: 'below-diversity' })
  })
})

describe('narrative relation', () => {
  it('reports an identity the record already answers to', () => {
    expect(relateNarrative(candidate(), [promotion()], LIMITS))
      .toEqual({ kind: 'identical', id: narrativeId(CANONICAL), overlap: 1 })
  })

  it('reports an identity folded into a narrative as a restatement earlier', () => {
    const absorbed = promotion({ restatements: ['  DISK TOTAL FULL writing cache local '] })
    expect(relateNarrative(candidate({ statement: RESTATED }), [absorbed], LIMITS))
      .toEqual({ kind: 'identical', id: narrativeId(CANONICAL), overlap: 1 })
  })

  it('reports a restatement of a held narrative', () => {
    expect(relateNarrative(candidate({ statement: RESTATED }), [promotion()], LIMITS))
      .toMatchObject({ kind: 'restates', id: narrativeId(CANONICAL) })
  })

  it('reports a correction of a held narrative', () => {
    expect(relateNarrative(candidate({ statement: CORRECTED }), [promotion()], LIMITS))
      .toMatchObject({ kind: 'corrects', id: narrativeId(CANONICAL) })
  })

  it('ignores a retired narrative, a different tool, and an unrelated statement', () => {
    const retired = promotion({ supersededBy: 'later', supersededAt: NOW })
    expect(relateNarrative(candidate(), [retired], LIMITS)).toBeUndefined()
    expect(relateNarrative(candidate({ statement: RESTATED }), [retired], LIMITS)).toBeUndefined()
    expect(relateNarrative(candidate({ statement: RESTATED }), [promotion({ tool: 'pwsh' })], LIMITS)).toBeUndefined()
    expect(relateNarrative(candidate({ statement: UNRELATED }), [promotion()], LIMITS)).toBeUndefined()
  })

  it('keeps the strongest overlap when several narratives are related', () => {
    const weak = promotion({ statement: CORRECTED })
    const strong = promotion({ statement: 'disk total full writing cache device' })
    const restating = candidate({ statement: 'disk total full writing cache local remote' })
    expect(relateNarrative(restating, [weak, strong], LIMITS))
      .toMatchObject({ kind: 'restates', id: strong.id })
    expect(relateNarrative(restating, [strong, weak], LIMITS))
      .toMatchObject({ kind: 'restates', id: strong.id })
  })
})

describe('narrative evolution', () => {
  it('adds a candidate the scope does not hold', () => {
    const outcome = evolveNarratives([], [qualified()], LIMITS, NOW)
    expect(outcome).toMatchObject({ promoted: 1, merged: 0, superseded: 0 })
    expect(outcome.promotions).toEqual([{
      id: narrativeId(CANONICAL),
      statement: CANONICAL,
      tool: 'bash',
      score: 0.8,
      signals: expect.anything() as unknown,
      promotedAt: NOW,
      evidence: { provenance: 'attributed', count: 9, sessions: 4 },
      restatements: [],
      supersededBy: null,
      supersededAt: null,
    }])
  })

  it('folds a restatement into the narrative it restates instead of duplicating it', () => {
    const held = promotion()
    const other = promotion({ statement: 'network timeout during signup', tool: 'curl' })
    const outcome = evolveNarratives([held, other], [qualified({ statement: RESTATED })], LIMITS, NOW)
    expect(outcome).toMatchObject({ promoted: 0, merged: 1, superseded: 0 })
    expect(outcome.promotions).toHaveLength(2)
    expect(outcome.promotions[0]?.restatements).toEqual([RESTATED])
    expect(outcome.promotions[0]?.statement).toBe(CANONICAL)
    expect(outcome.promotions[1]).toEqual(other)
  })

  it('leaves an identity the scope already holds untouched', () => {
    const held = promotion()
    const outcome = evolveNarratives([held], [qualified()], LIMITS, NOW)
    expect(outcome).toMatchObject({ promoted: 0, merged: 0, superseded: 0 })
    expect(outcome.promotions).toEqual([held])
  })

  it('bounds the restatements one narrative retains', () => {
    const held = promotion({ restatements: ['disk total full writing cache local', 'disk total full writing cache remote'] })
    const outcome = evolveNarratives([held], [qualified({ statement: 'disk total full writing cache device' })], LIMITS, NOW)
    expect(outcome.promotions[0]?.restatements).toHaveLength(LIMITS.maxRestatements)
    expect(outcome.promotions[0]?.restatements[0]).toBe('disk total full writing cache local')
  })

  it('retires the predecessor a correction replaces and answers with the correction', () => {
    const held = promotion()
    const other = promotion({ statement: 'network timeout during signup', tool: 'curl' })
    const outcome = evolveNarratives([held, other], [qualified({ statement: CORRECTED })], LIMITS, NOW)
    expect(outcome).toMatchObject({ promoted: 1, merged: 0, superseded: 1 })
    expect(outcome.promotions[0]).toMatchObject({ statement: CORRECTED, supersededBy: null })
    expect(outcome.promotions[1]).toMatchObject({ id: held.id, supersededBy: narrativeId(CORRECTED), supersededAt: NOW })
    expect(outcome.promotions[2]).toEqual(other)
  })

  it('folds two restatements that arrive in one pass into a single narrative', () => {
    const outcome = evolveNarratives([], [
      qualified({ statement: CANONICAL }),
      qualified({ statement: RESTATED }),
    ], LIMITS, NOW)
    expect(outcome).toMatchObject({ promoted: 1, merged: 1, superseded: 0 })
    expect(outcome.promotions).toHaveLength(1)
  })
})
