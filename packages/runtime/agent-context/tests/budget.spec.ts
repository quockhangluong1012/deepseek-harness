import { describe, expect, it } from 'vitest'
import { fitBudget, priceOf, priceSources } from '../src/budget.ts'
import type { CompiledSource, ContextSource, ContextSourceKind, RetentionClass } from '../src/types.ts'

/** One envelope fixture. */
function source(id: string, retention: RetentionClass, content = id, kind: ContextSourceKind = 'tool'): ContextSource {
  return { id, kind, content, trust: 'trusted', provenance: { source: 'kernel', locator: id }, retention }
}

/** One priced fixture at an explicit price. */
function priced(id: string, retention: RetentionClass, tokens: number): CompiledSource {
  return { source: source(id, retention), relevance: 0, tokens }
}

describe('token pricing', () => {
  it('prices content under the token meter fixed density heuristic', () => {
    // Four characters per token plus one block's structural overhead, exactly
    // as `@deepseek-ai/dsh-token-meter/estimate` prices a text block.
    expect(priceOf(source('a', 'tool', 'abcd'))).toBe(5)
    expect(priceOf(source('a', 'tool', 'abcde'))).toBe(6)
  })

  it('attaches each scored source its price', () => {
    const priced_ = priceSources([
      { source: source('a', 'tool', 'abcd'), relevance: 1 },
      { source: source('b', 'tool', 'abcdefgh'), relevance: 0 },
    ])
    expect(priced_.map(entry => entry.tokens)).toEqual([5, 6])
    expect(priced_[0]?.relevance).toBe(1)
  })
})

describe('budget cut', () => {
  it('places everything when there is no ceiling', () => {
    const placement = fitBudget([priced('a', 'compressible', 1000), priced('b', 'required', 1000)], null)
    expect(placement.included.map(entry => entry.source.id)).toEqual(['a', 'b'])
    expect(placement.omitted).toEqual([])
    expect(placement.tokenEstimate).toBe(2000)
  })

  it('cuts a prefix of the placement order once a droppable source does not fit', () => {
    const placement = fitBudget([
      priced('a', 'compressible', 6),
      priced('b', 'compressible', 100),
      priced('c', 'compressible', 1),
    ], 10)
    expect(placement.included.map(entry => entry.source.id)).toEqual(['a'])
    expect(placement.omitted).toEqual([
      { id: 'b', reason: 'budget' },
      { id: 'c', reason: 'budget' },
    ])
    expect(placement.tokenEstimate).toBe(6)
  })

  it('places a required source alone above the ceiling', () => {
    const placement = fitBudget([priced('policy', 'required', 500)], 10)
    expect(placement.included.map(entry => entry.source.id)).toEqual(['policy'])
    expect(placement.omitted).toEqual([])
    expect(placement.tokenEstimate).toBe(500)
  })

  it('still places a required source that follows the cut', () => {
    const placement = fitBudget([priced('a', 'compressible', 100), priced('policy', 'required', 100)], 10)
    expect(placement.included.map(entry => entry.source.id)).toEqual(['policy'])
    expect(placement.omitted).toEqual([{ id: 'a', reason: 'budget' }])
  })

  it('places a compressible source that exactly fills the ceiling', () => {
    const placement = fitBudget([priced('a', 'compressible', 10)], 10)
    expect(placement.included.map(entry => entry.source.id)).toEqual(['a'])
    expect(placement.omitted).toEqual([])
  })
})
