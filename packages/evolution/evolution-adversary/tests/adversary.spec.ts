import { describe, expect, it } from 'vitest'
import {
  ADVERSARIAL_CATEGORIES,
  categoryCoverage,
  defenseGaps,
  GAMING_DEFENSES,
  nextChallenge,
  uncoveredCategories,
  weaknessRate,
} from '../src/adversary.ts'
import type { AdversarialProbe, DefenseStatus } from '../src/types.ts'

const probe = (overrides: Partial<AdversarialProbe> = {}): AdversarialProbe => ({
  probeId: 'p1',
  skill: 'writer',
  category: 'edge-case',
  probe: 'Tricky input.',
  foundWeakness: false,
  repaired: false,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const status = (overrides: Partial<DefenseStatus> = {}): DefenseStatus => ({
  defense: 'multiple-evaluators',
  satisfied: true,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('canonical lists', () => {
  it('keeps the eight §45 categories and six §46 defenses in spec order', () => {
    expect([...ADVERSARIAL_CATEGORIES]).toEqual([
      'edge-case',
      'prompt-injection',
      'stale-memory',
      'retrieval-trap',
      'contradictory-evidence',
      'tool-failure',
      'ambiguous-instruction',
      'evaluator-gaming',
    ])
    expect([...GAMING_DEFENSES]).toEqual([
      'multiple-evaluators',
      'hidden-holdout',
      'behavioral-metrics',
      'adversarial-tests',
      'randomized-tests',
      'evaluator-rotation',
    ])
  })
})

describe('categoryCoverage', () => {
  it('zero-fills every category for a skill with no probes', () => {
    expect(categoryCoverage([], 'writer')).toEqual({
      'edge-case': 0,
      'prompt-injection': 0,
      'stale-memory': 0,
      'retrieval-trap': 0,
      'contradictory-evidence': 0,
      'tool-failure': 0,
      'ambiguous-instruction': 0,
      'evaluator-gaming': 0,
    })
  })

  it('counts one skill only', () => {
    const rows = [
      probe({ probeId: 'a', category: 'edge-case' }),
      probe({ probeId: 'b', category: 'edge-case' }),
      probe({ probeId: 'c', category: 'tool-failure', foundWeakness: true }),
      probe({ probeId: 'd', skill: 'reader', category: 'edge-case' }),
    ]
    const coverage = categoryCoverage(rows, 'writer')
    expect(coverage['edge-case']).toBe(2)
    expect(coverage['tool-failure']).toBe(1)
    expect(coverage['prompt-injection']).toBe(0)
    expect(categoryCoverage(rows, 'reader')['edge-case']).toBe(1)
  })

  it('counts a probe of an unknown category under its own key', () => {
    // A future weakness family not yet in the canonical list must not crash
    // the counter; the `?? 0` fallback keeps the count going under its own key.
    const rows = [probe({ category: 'future-family' as AdversarialProbe['category'] })]
    const coverage = categoryCoverage(rows, 'writer')
    expect(coverage['edge-case']).toBe(0)
    expect((coverage as unknown as Record<string, number>)['future-family']).toBe(1)
  })
})

describe('uncoveredCategories', () => {
  it('names every category below a minimum of one in canonical order', () => {
    const rows = [probe({ category: 'tool-failure' })]
    expect(uncoveredCategories(rows, 'writer', 1)).toEqual([
      'edge-case',
      'prompt-injection',
      'stale-memory',
      'retrieval-trap',
      'contradictory-evidence',
      'ambiguous-instruction',
      'evaluator-gaming',
    ])
  })

  it('holds a category at the minimum of two until its second probe', () => {
    const rows = [
      probe({ probeId: 'a', category: 'edge-case' }),
      probe({ probeId: 'b', category: 'edge-case' }),
      probe({ probeId: 'c', category: 'prompt-injection' }),
    ]
    const uncovered = uncoveredCategories(rows, 'writer', 2)
    expect(uncovered[0]).toBe('prompt-injection')
    expect(uncovered).not.toContain('edge-case')
    expect(uncovered).toHaveLength(7)
  })

  it('reports nothing when every category is covered', () => {
    const rows = ADVERSARIAL_CATEGORIES.map((category, index) => probe({ probeId: `p${index}`, category }))
    expect(uncoveredCategories(rows, 'writer', 1)).toEqual([])
  })
})

describe('nextChallenge', () => {
  it('challenges the first uncovered category with its probe count', () => {
    expect(nextChallenge([], 'writer', 1)).toEqual({
      skill: 'writer',
      category: 'edge-case',
      probed: 0,
      reason: 'edge-case has 0 probes, below the 1 minimum',
    })
  })

  it('words the uncovered reason with the category count and minimum', () => {
    const rows = [probe({ category: 'edge-case' })]
    expect(nextChallenge(rows, 'writer', 2)).toEqual({
      skill: 'writer',
      category: 'edge-case',
      probed: 1,
      reason: 'edge-case has 1 probes, below the 2 minimum',
    })
  })

  it('rotates to the least-probed category once all are covered', () => {
    const rows = ADVERSARIAL_CATEGORIES.map((category, index) => probe({ probeId: `p${index}`, category }))
    rows.push(probe({ probeId: 'extra', category: 'edge-case' }))
    const challenge = nextChallenge(rows, 'writer', 1)
    expect(challenge).toEqual({
      skill: 'writer',
      category: 'prompt-injection',
      probed: 1,
      reason: 'all categories covered; rotating the least-probed',
    })
  })

  it('breaks least-probed ties in canonical order', () => {
    const rows = ADVERSARIAL_CATEGORIES.map((category, index) => probe({ probeId: `p${index}`, category }))
    expect(nextChallenge(rows, 'writer', 1)).toEqual({
      skill: 'writer',
      category: 'edge-case',
      probed: 1,
      reason: 'all categories covered; rotating the least-probed',
    })
  })
})

describe('weaknessRate', () => {
  it('reports null for a skill with no probes', () => {
    expect(weaknessRate([], 'writer')).toBeNull()
    expect(weaknessRate([probe({ skill: 'reader', foundWeakness: true })], 'writer')).toBeNull()
  })

  it('shares found weaknesses over the skill total', () => {
    const rows = [
      probe({ probeId: 'a', foundWeakness: true }),
      probe({ probeId: 'b', foundWeakness: false }),
      probe({ probeId: 'c', skill: 'reader', foundWeakness: true }),
    ]
    expect(weaknessRate(rows, 'writer')).toBe(0.5)
    expect(weaknessRate(rows, 'reader')).toBe(1)
    expect(weaknessRate([probe({ foundWeakness: false })], 'writer')).toBe(0)
  })
})

describe('defenseGaps', () => {
  it('names unsatisfied defenses in canonical order', () => {
    const rows = GAMING_DEFENSES.map((defense) => status({ defense, satisfied: defense === 'multiple-evaluators' }))
    expect(defenseGaps(rows)).toEqual([
      'hidden-holdout',
      'behavioral-metrics',
      'adversarial-tests',
      'randomized-tests',
      'evaluator-rotation',
    ])
  })

  it('treats a missing row as an open gap and an empty list as all open', () => {
    expect(defenseGaps([status({ defense: 'hidden-holdout', satisfied: true })])).toHaveLength(5)
    expect(defenseGaps([status({ defense: 'hidden-holdout', satisfied: true })])[0]).toBe('multiple-evaluators')
    expect(defenseGaps([])).toEqual([...GAMING_DEFENSES])
  })

  it('reports no gaps when every defense holds', () => {
    const rows = GAMING_DEFENSES.map((defense) => status({ defense }))
    expect(defenseGaps(rows)).toEqual([])
  })
})
