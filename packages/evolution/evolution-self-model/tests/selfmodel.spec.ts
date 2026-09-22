import { describe, expect, it } from 'vitest'
import { frontierGaps, mergeModel, nextToLearn, observeCapability } from '../src/selfmodel.ts'
import type { CapabilityEntry, CapabilityObservation, SelfModel, SelfModelInput } from '../src/types.ts'

const input = (overrides: Partial<SelfModelInput> = {}): SelfModelInput => ({
  skill: 'writer',
  strengths: ['draft'],
  weaknesses: ['brevity'],
  uncertainAreas: ['humor'],
  failureModes: ['rambling'],
  preferredTools: ['search'],
  evaluatorBlindspots: ['tone'],
  confidence: 0.6,
  ...overrides,
})

const prevModel = (overrides: Partial<SelfModel> = {}): SelfModel => ({
  ...input(),
  revision: 3,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const entry = (overrides: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  capability: 'lint',
  score: 1,
  confidence: 0.1,
  failures: [],
  coveringSkills: ['writer'],
  observations: 1,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const obs = (overrides: Partial<CapabilityObservation> = {}): CapabilityObservation => ({
  capability: 'lint',
  skill: 'writer',
  pass: true,
  ...overrides,
})

describe('mergeModel', () => {
  it('starts at revision 1 for a skill’s first assessment', () => {
    const offered = input()
    const merged = mergeModel(null, offered, '2026-02-01T00:00:00.000Z')
    expect(merged).toEqual({ ...offered, revision: 1, at: '2026-02-01T00:00:00.000Z' })
    merged.strengths.push('mutated')
    expect(offered.strengths).toEqual(['draft'])
  })

  it('ticks the revision and replaces every list wholesale', () => {
    const merged = mergeModel(prevModel({ strengths: ['stale'] }), input({ strengths: ['draft', 'outline'] }), '2026-03-01T00:00:00.000Z')
    expect(merged.revision).toBe(4)
    expect(merged.strengths).toEqual(['draft', 'outline'])
    expect(merged.at).toBe('2026-03-01T00:00:00.000Z')
  })
})

describe('observeCapability', () => {
  it('creates the first entry from a pass', () => {
    expect(observeCapability(null, obs(), '2026-02-01T00:00:00.000Z')).toEqual({
      capability: 'lint',
      score: 1,
      confidence: 0.1,
      failures: [],
      coveringSkills: ['writer'],
      observations: 1,
      at: '2026-02-01T00:00:00.000Z',
    })
  })

  it('tracks the running pass rate across passes and failures', () => {
    const afterPass = observeCapability(null, obs(), '2026-02-01T00:00:00.000Z')
    const afterFail = observeCapability(afterPass, obs({ pass: false }), '2026-02-02T00:00:00.000Z')
    expect(afterFail.score).toBe(0.5)
    expect(afterFail.observations).toBe(2)
    const afterRecovery = observeCapability(afterFail, obs({ skill: 'reader' }), '2026-02-03T00:00:00.000Z')
    expect(afterRecovery.score).toBeCloseTo(2 / 3)
    expect(afterRecovery.at).toBe('2026-02-03T00:00:00.000Z')
  })

  it('grows confidence toward the cap with the observation count', () => {
    let current = observeCapability(null, obs(), '2026-02-01T00:00:00.000Z')
    expect(current.confidence).toBe(0.1)
    for (let index = 2; index <= 10; index += 1) {
      current = observeCapability(current, obs(), '2026-02-01T00:00:00.000Z')
    }
    expect(current.confidence).toBe(1)
    const capped = observeCapability(current, obs(), '2026-02-01T00:00:00.000Z')
    expect(capped.confidence).toBe(1)
    const wide = observeCapability(null, obs(), '2026-02-01T00:00:00.000Z', 4)
    expect(wide.confidence).toBe(0.25)
    const full = observeCapability(observeCapability(observeCapability(wide, obs(), '2026-02-01T00:00:00.000Z', 4), obs(), '2026-02-01T00:00:00.000Z', 4), obs(), '2026-02-01T00:00:00.000Z', 4)
    expect(full.confidence).toBe(1)
  })

  it('prepends failures newest-first, caps them, and keeps them without a note', () => {
    const first = observeCapability(null, obs({ pass: false, failure: 'a' }), '2026-02-01T00:00:00.000Z')
    expect(first.failures).toEqual(['a'])
    const second = observeCapability(first, obs({ pass: false, failure: 'b' }), '2026-02-02T00:00:00.000Z')
    expect(second.failures).toEqual(['b', 'a'])
    const capped = observeCapability(second, obs({ pass: false, failure: 'c' }), '2026-02-03T00:00:00.000Z', 10, 2)
    expect(capped.failures).toEqual(['c', 'b'])
    const quiet = observeCapability(second, obs({ pass: false }), '2026-02-04T00:00:00.000Z')
    expect(quiet.failures).toEqual(['b', 'a'])
  })

  it('unions covering skills in first-seen order', () => {
    const first = observeCapability(null, obs(), '2026-02-01T00:00:00.000Z')
    const repeat = observeCapability(first, obs(), '2026-02-02T00:00:00.000Z')
    expect(repeat.coveringSkills).toEqual(['writer'])
    const joined = observeCapability(repeat, obs({ skill: 'reader' }), '2026-02-03T00:00:00.000Z')
    expect(joined.coveringSkills).toEqual(['writer', 'reader'])
  })
})

describe('frontierGaps', () => {
  it('ranks weakest first with deterministic tie-breaks', () => {
    const entries = [
      entry({ capability: 'strong', score: 0.9, confidence: 1, coveringSkills: ['a'], observations: 10 }),
      entry({ capability: 'confident', score: 0.2, confidence: 0.9, coveringSkills: ['a'], observations: 9 }),
      entry({ capability: 'wide', score: 0.2, confidence: 0.2, coveringSkills: ['a', 'b'], observations: 2 }),
      entry({ capability: 'zeta', score: 0.2, confidence: 0.2, coveringSkills: ['a'], observations: 2 }),
      entry({ capability: 'amber', score: 0.2, confidence: 0.2, coveringSkills: ['a'], observations: 2 }),
    ]
    const gaps = frontierGaps(entries)
    // Same score: thinner evidence first; same evidence: fewer skills first;
    // same coverage: the capability name decides.
    expect(gaps.map((gap) => gap.capability)).toEqual(['amber', 'zeta', 'wide', 'confident', 'strong'])
    expect(gaps[0]).toEqual({
      capability: 'amber',
      score: 0.2,
      confidence: 0.2,
      coveringSkills: ['a'],
      observations: 2,
    })
    const ranked = gaps[0] as { coveringSkills: string[] }
    ranked.coveringSkills.push('mutated')
    expect(entries[4]?.coveringSkills).toEqual(['a'])
  })

  it('returns an empty frontier for no entries', () => {
    expect(frontierGaps([])).toEqual([])
  })
})

describe('nextToLearn', () => {
  it('returns null on empty and the weakest gap otherwise', () => {
    expect(nextToLearn([])).toBeNull()
    const entries = [
      entry({ capability: 'strong', score: 0.9, confidence: 1, observations: 10 }),
      entry({ capability: 'weak', score: 0.1, confidence: 0.4, coveringSkills: ['reader'], observations: 4 }),
    ]
    expect(nextToLearn(entries)?.capability).toBe('weak')
  })
})
