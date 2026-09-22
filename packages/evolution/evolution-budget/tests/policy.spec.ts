import { describe, expect, it } from 'vitest'
import { policyFor } from '../src/policy.ts'
import type { PolicyThresholds, PooledCandidateInput } from '../src/types.ts'

const bars: PolicyThresholds = { provenPasses: 1, lowPotentialRuns: 1, noveltyThreshold: 0.5 }

const candidate = (overrides: Partial<PooledCandidateInput> = {}): PooledCandidateInput => ({
  candidateId: 'c1',
  runs: 0,
  passes: 0,
  novelty: 0,
  ...overrides,
})

describe('policyFor', () => {
  it('gives a proven candidate more budget', () => {
    const decision = policyFor(candidate({ runs: 3, passes: 2 }), bars)
    expect(decision).toMatchObject({ candidateId: 'c1', candidateClass: 'high-potential', branch: 'more-budget' })
    expect(decision.reason).toBe('branch more-budget: 2 passes of 3 recorded runs reach the 1-pass bar')
  })

  it('early-stops a measured candidate with nothing novel', () => {
    const decision = policyFor(candidate({ runs: 2, passes: 0, novelty: 0.2 }), bars)
    expect(decision).toMatchObject({ candidateClass: 'low-potential', branch: 'early-stop' })
    expect(decision.reason).toContain('branch early-stop: 2 recorded runs and 0 passes')
  })

  it('gives an unproven novel candidate the exploration allowance', () => {
    const decision = policyFor(candidate({ runs: 1, passes: 0, novelty: 0.8 }), bars)
    expect(decision).toMatchObject({ candidateClass: 'novel', branch: 'exploration-budget' })
    expect(decision.reason).toBe('branch exploration-budget: novelty 0.8 reaches 0.5 without a proven pass')
  })

  it('gives a candidate that reaches no bar the standard batch', () => {
    const decision = policyFor(candidate({ runs: 0, passes: 0, novelty: 0.1 }), bars)
    expect(decision).toMatchObject({ candidateClass: 'standard', branch: 'standard' })
    expect(decision.reason).toBe('branch standard: 0 recorded runs, 0 passes, and novelty 0.1 reach no policy bar')
  })

  it('decides by the deployment bars it is given', () => {
    const strict: PolicyThresholds = { provenPasses: 2, lowPotentialRuns: 3, noveltyThreshold: 0.9 }
    // One pass misses a two-pass bar, and a novel candidate below the bar with
    // too few runs to stop on falls through to the standard batch.
    expect(policyFor(candidate({ runs: 1, passes: 1 }), strict).branch).toBe('standard')
    expect(policyFor(candidate({ runs: 2, passes: 0 }), strict).branch).toBe('standard')
    expect(policyFor(candidate({ runs: 3, passes: 0 }), strict).branch).toBe('early-stop')
    expect(policyFor(candidate({ runs: 0, passes: 0, novelty: 0.9 }), strict).branch).toBe('exploration-budget')
  })
})
