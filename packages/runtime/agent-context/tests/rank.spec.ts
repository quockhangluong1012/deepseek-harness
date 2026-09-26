import { describe, expect, it } from 'vitest'
import { compareCompiled, compareText, relevanceOf, scoreSources, termsOf } from '../src/rank.ts'
import type { CompiledSource, ContextSource, ContextSourceKind, RetentionClass } from '../src/types.ts'

/** One envelope fixture; every field is overridable so a spec states only what it orders by. */
function source(id: string, kind: ContextSourceKind, trust: ContextSource['trust'], retention: RetentionClass = 'compressible'): ContextSource {
  return { id, kind, content: id, trust, sourceRef: { source: 'kernel', locator: id }, retention }
}

/** One priced fixture. */
function priced(id: string, kind: ContextSourceKind, trust: ContextSource['trust'], relevance: number): CompiledSource {
  return { source: source(id, kind, trust), relevance, tokens: 1 }
}

describe('objective terms', () => {
  it('keeps lower-cased terms of three or more characters', () => {
    expect([...termsOf('Fix THE Build, Please')]).toEqual(['fix', 'the', 'build', 'please'])
  })

  it('has no terms when nothing is long enough', () => {
    expect(termsOf('a b c').size).toBe(0)
  })
})

describe('relevance', () => {
  it('is the fraction of the objective terms one source mentions', () => {
    const terms = termsOf('fix the failing build')
    expect(relevanceOf({ ...source('a', 'tool', 'trusted'), content: 'the build' }, terms)).toBeCloseTo(2 / 4)
    expect(relevanceOf({ ...source('b', 'tool', 'trusted'), content: 'unrelated prose' }, terms)).toBe(0)
  })

  it('is zero without an objective', () => {
    expect(relevanceOf(source('a', 'tool', 'trusted'), new Set())).toBe(0)
  })

  it('attaches each source its relevance in input order', () => {
    const scored = scoreSources(
      [{ ...source('a', 'tool', 'trusted'), content: 'fix the build' }, source('b', 'tool', 'trusted')],
      'fix the build',
    )
    expect(scored.map(entry => entry.source.id)).toEqual(['a', 'b'])
    expect(scored[0]?.relevance).toBe(1)
    expect(scored[1]?.relevance).toBe(0)
  })
})

describe('placement order', () => {
  it('orders trust tiers before everything else', () => {
    const trustedTool = priced('tool:read', 'tool', 'trusted', 0)
    const unknownPolicy = priced('policy:unknown', 'policy', 'unknown', 1)
    const untrustedPolicy = priced('policy:repo', 'policy', 'untrusted', 1)
    expect([untrustedPolicy, unknownPolicy, trustedTool].sort(compareCompiled).map(entry => entry.source.id))
      .toEqual(['tool:read', 'policy:unknown', 'policy:repo'])
  })

  it('orders the task authority ahead of guidance inside one trust tier', () => {
    const policy = priced('sandbox:policy', 'policy', 'trusted', 0)
    const plan = priced('plan:1', 'plan', 'trusted', 0)
    const tool = priced('tool:read', 'tool', 'trusted', 0)
    expect([tool, plan, policy].sort(compareCompiled).map(entry => entry.source.id))
      .toEqual(['sandbox:policy', 'plan:1', 'tool:read'])
  })

  it('orders the more relevant source first inside one kind', () => {
    const near = priced('tool:a', 'tool', 'trusted', 0.75)
    const far = priced('tool:z', 'tool', 'trusted', 0.25)
    expect([near, far].sort(compareCompiled)[0]?.source.id).toBe('tool:a')
  })

  it('breaks every remaining tie by id, in both directions', () => {
    const a = priced('tool:a', 'tool', 'trusted', 0.5)
    const b = priced('tool:b', 'tool', 'trusted', 0.5)
    expect(compareCompiled(a, b)).toBeLessThan(0)
    expect(compareCompiled(b, a)).toBeGreaterThan(0)
    expect(compareCompiled(a, a)).toBe(0)
  })
})

describe('text order', () => {
  it('orders by code unit in both directions and reports equality', () => {
    expect(compareText('a', 'b')).toBeLessThan(0)
    expect(compareText('b', 'a')).toBeGreaterThan(0)
    expect(compareText('a', 'a')).toBe(0)
  })
})
