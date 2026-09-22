import { describe, expect, it } from 'vitest'
import { composabilityRefusal, compositionRefusal } from '../src/composition.ts'

const requested = { name: 'composed-skill' }

describe('skill composition rules', () => {
  it('admits a set nobody declared a relation against', () => {
    expect(compositionRefusal(requested, [])).toBeUndefined()
    expect(compositionRefusal(requested, [{ name: 'base-skill' }])).toBeUndefined()
  })

  it('refuses a conflict declared by either side of the pair', () => {
    expect(compositionRefusal({ name: 'composed-skill', conflictsWith: ['rival-skill'] }, [{ name: 'rival-skill' }]))
      .toBe('skill "composed-skill" cannot load: "composed-skill" and "rival-skill" declare a conflict')
    expect(compositionRefusal(requested, [{ name: 'rival-skill', conflictsWith: ['composed-skill'] }]))
      .toBe('skill "composed-skill" cannot load: "rival-skill" and "composed-skill" declare a conflict')
  })

  it('ignores a conflict naming the declaring skill itself or a skill outside the set', () => {
    expect(compositionRefusal(
      { name: 'composed-skill', conflictsWith: ['composed-skill'] },
      [{ name: 'rival-skill', conflictsWith: ['absent-skill'] }],
    )).toBeUndefined()
  })

  it('refuses a member an allowlist excludes and admits one it names', () => {
    expect(compositionRefusal(
      { name: 'composed-skill', compatibleWith: ['base-skill'] },
      [{ name: 'base-skill' }, { name: 'rival-skill' }],
    )).toBe('skill "composed-skill" cannot load: "composed-skill" is not compatible with "rival-skill"')
    // The relation is symmetric: a member's allowlist governs the requested skill too.
    expect(compositionRefusal(requested, [{ name: 'base-skill', compatibleWith: ['rival-skill'] }]))
      .toBe('skill "composed-skill" cannot load: "base-skill" is not compatible with "composed-skill"')
    expect(compositionRefusal(
      { name: 'composed-skill', compatibleWith: ['base-skill', 'rival-skill'] },
      [{ name: 'base-skill' }, { name: 'rival-skill' }],
    )).toBeUndefined()
    // An empty list names nobody, so it constrains nobody.
    expect(compositionRefusal({ name: 'composed-skill', compatibleWith: [] }, [{ name: 'base-skill' }]))
      .toBeUndefined()
  })

  it('refuses a synthesis source set a composability allowlist excludes', () => {
    expect(composabilityRefusal([{ name: 'alpha' }, { name: 'beta' }])).toBeUndefined()
    expect(composabilityRefusal([{ name: 'alpha', composableWith: [] }, { name: 'beta' }])).toBeUndefined()
    expect(composabilityRefusal([{ name: 'alpha', composableWith: ['beta'] }, { name: 'beta' }])).toBeUndefined()
    expect(composabilityRefusal([{ name: 'alpha', composableWith: ['gamma'] }, { name: 'beta' }]))
      .toBe('"alpha" is not composable with "beta"')
    expect(composabilityRefusal([{ name: 'alpha' }, { name: 'beta', composableWith: ['gamma'] }]))
      .toBe('"beta" is not composable with "alpha"')
  })
})
