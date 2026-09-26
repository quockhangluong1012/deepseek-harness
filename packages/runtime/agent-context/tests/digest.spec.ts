import { describe, expect, it } from 'vitest'
import { contentDigest, digestPlacement } from '../src/digest.ts'
import type { CompiledSource, ContextConflict, ContextOmission, ContextSource } from '../src/types.ts'

/** One envelope fixture. */
function source(id: string, content = id): ContextSource {
  return { id, kind: 'task', content, trust: 'trusted', sourceRef: { source: 'kernel', locator: id }, retention: 'required' }
}

/** One priced fixture. */
function priced(id: string, content = id, tokens = 5): CompiledSource {
  return { source: source(id, content), relevance: 0.5, tokens }
}

/** One omission fixture. */
const OMITTED: ContextOmission = { id: 'tool:x', reason: 'budget' }

/** One conflict fixture. */
const CONFLICT: ContextConflict = { subject: 'plan', sources: ['plan:1', 'plan:2'] }

/** Digest one placement with every component at a fixed baseline. */
function digest(overrides: {
  compilerVersion?: string
  maxTokens?: number | null
  included?: CompiledSource[]
  omitted?: ContextOmission[]
  conflicts?: ContextConflict[]
} = {}): string {
  return digestPlacement(
    overrides.compilerVersion ?? 'agent-context/1',
    overrides.maxTokens ?? null,
    overrides.included ?? [priced('task:a')],
    overrides.omitted ?? [],
    overrides.conflicts ?? [],
  )
}

describe('content digest', () => {
  it('is a stable SHA-256 of the text', () => {
    expect(contentDigest('hello')).toMatch(/^[0-9a-f]{64}$/)
    expect(contentDigest('hello')).toBe(contentDigest('hello'))
    expect(contentDigest('hello')).not.toBe(contentDigest('hello '))
  })
})

describe('placement digest', () => {
  it('is stable for one placement', () => {
    expect(digest()).toBe(digest())
  })

  it('covers the compiler version, the ceiling, and every omission and conflict', () => {
    const baseline = digest()
    expect(digest({ compilerVersion: 'agent-context/2' })).not.toBe(baseline)
    expect(digest({ maxTokens: 100 })).not.toBe(baseline)
    expect(digest({ omitted: [OMITTED] })).not.toBe(baseline)
    expect(digest({ conflicts: [CONFLICT] })).not.toBe(baseline)
  })

  it('covers every field of a placed source', () => {
    const baseline = digest()
    expect(digest({ included: [priced('task:b')] })).not.toBe(baseline)
    expect(digest({ included: [priced('task:a', 'other content')] })).not.toBe(baseline)
    expect(digest({ included: [priced('task:a', 'task:a', 6)] })).not.toBe(baseline)
  })

  it('changes when the placement order changes', () => {
    const first = digest({ included: [priced('task:a'), priced('task:b')] })
    const second = digest({ included: [priced('task:b'), priced('task:a')] })
    expect(first).not.toBe(second)
  })
})
