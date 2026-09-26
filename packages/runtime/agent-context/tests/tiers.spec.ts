/**
 * The context tiers and the on-demand gate: the derived tier table, and the
 * gate that withholds a configured tier until a compile asks for it.
 */
import { describe, expect, it } from 'vitest'
import { DefaultContextCompiler } from '../src/compile.ts'
import type { ContextCompileInput } from '../src/compile.ts'
import { CONTEXT_TIERS, TIER_OF_KIND, admitSources } from '../src/tiers.ts'
import type { ContextSource, ContextSourceKind, RetentionClass } from '../src/types.ts'

const KINDS: readonly ContextSourceKind[] = ['policy', 'task', 'plan', 'memory', 'evidence', 'artifact', 'history', 'tool']

/** One envelope fixture. */
function source(
  id: string,
  kind: ContextSourceKind,
  content = `content of ${id}`,
  retention: RetentionClass = 'compressible',
): ContextSource {
  return {
    id,
    kind,
    content,
    trust: 'trusted',
    sourceRef: { source: 'kernel', locator: id },
    retention,
  }
}

/** An assembly with one section per given name and text. */
function assemblyOf(sections: readonly [string, string][] = []): ContextCompileInput['assembly'] {
  return { sections: sections.map(([name, text]) => ({ name, text })), contexts: [], tools: [], variables: {} }
}

const compiler = new DefaultContextCompiler()

describe('the tier table', () => {
  it('places every source kind in one tier of the specification', () => {
    const tiers = KINDS.map(kind => TIER_OF_KIND[kind])
    expect(tiers).toEqual(['L0', 'L1', 'L2', 'L3', 'L2', 'L5', 'L4', 'L4'])
    expect(new Set(tiers).size).toBeLessThan(KINDS.length)
    for (const tier of tiers) expect(CONTEXT_TIERS).toContain(tier)
  })
})

describe('admitSources', () => {
  const candidates = [
    source('policy:harness', 'policy', 'you are the harness', 'required'),
    source('memory:one', 'memory'),
    source('history:turn-1', 'history'),
  ]

  it('withholds the configured compressible tier and reports what it withheld', () => {
    const admission = admitSources(candidates, ['L3'])
    expect(admission.admitted.map(entry => entry.id)).toEqual(['policy:harness', 'history:turn-1'])
    expect(admission.deferred).toEqual([{ id: 'memory:one', kind: 'memory', tier: 'L3' }])
  })

  it('admits a required source whatever its tier, so the ceiling invariant holds', () => {
    // A required source is placed before any cut is consulted, and the tier
    // policy is a cut like the ceiling is: naming its tier withholds nothing.
    expect(admitSources(candidates, ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']).admitted.map(entry => entry.id))
      .toEqual(['policy:harness'])
  })

  it('admits a withheld tier and a withheld source id when the compile asks', () => {
    expect(admitSources(candidates, ['L3'], { tiers: ['L3'] }).deferred).toEqual([])
    expect(admitSources(candidates, ['L3'], { sourceIds: ['memory:one'] }).admitted.map(entry => entry.id))
      .toEqual(['policy:harness', 'memory:one', 'history:turn-1'])
    expect(admitSources(candidates, ['L6']).deferred).toEqual([])
  })
})

describe('the compile gate', () => {
  it('leaves the placement unchanged when no tier is on demand', async () => {
    const input: ContextCompileInput = {
      assembly: assemblyOf([['tool:read', 'read a file']]),
      sources: [source('memory:one', 'memory')],
      objective: 'read a file',
    }
    const first = await compiler.compile(input)
    expect(first.deferred).toEqual([])
    expect(first.included.map(entry => entry.source.id)).toEqual(['memory:one', 'tool:read'])
    expect((await compiler.compile(input)).digest).toBe(first.digest)
  })

  it('withholds an on-demand tier from the placement and the digest', async () => {
    const sources = [source('memory:one', 'memory'), source('history:turn-1', 'history')]
    const gated = await compiler.compile({
      assembly: assemblyOf([['harness:identity', 'you are the harness']]),
      sources,
      objective: 'read a file',
      onDemandTiers: ['L3', 'L4'],
    })
    expect(gated.included.map(entry => entry.source.id)).toEqual(['harness:identity'])
    expect(gated.omitted).toEqual([])
    expect(gated.deferred).toEqual([
      { id: 'memory:one', kind: 'memory', tier: 'L3' },
      { id: 'history:turn-1', kind: 'history', tier: 'L4' },
    ])

    // A withheld source is not an omission: a placement the withheld candidates
    // never reached is the same placement, and compiles to the same digest.
    const absent = await compiler.compile({
      assembly: assemblyOf([['harness:identity', 'you are the harness']]),
      sources: [],
      objective: 'read a file',
    })
    expect(absent.digest).toBe(gated.digest)

    const demanded = await compiler.compile({
      assembly: assemblyOf([['harness:identity', 'you are the harness']]),
      sources,
      objective: 'read a file',
      onDemandTiers: ['L3', 'L4'],
      demand: { tiers: ['L3'], sourceIds: ['history:turn-1'] },
    })
    expect(demanded.included.map(entry => entry.source.id)).toEqual(['harness:identity', 'memory:one', 'history:turn-1'])
    expect(demanded.deferred).toEqual([])
  })
})
