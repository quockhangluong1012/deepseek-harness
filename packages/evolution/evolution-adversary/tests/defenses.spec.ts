import { describe, expect, it } from 'vitest'
import { observeDefenses } from '../src/defenses.ts'
import type { DefenseFacts, DefenseObservation } from '../src/defenses.ts'
import type { AdversarialCategory, AdversarialProbe, GamingDefense } from '../src/types.ts'

const probe = (category: AdversarialCategory, skill = 'writer'): AdversarialProbe => ({
  probeId: `${skill}-${category}`,
  skill,
  category,
  probe: 'Tricky input.',
  foundWeakness: false,
  repaired: false,
  at: '2026-01-01T00:00:00.000Z',
})

const facts = (overrides: Partial<DefenseFacts> = {}): DefenseFacts => ({
  strategies: null,
  holdouts: null,
  evaluationRoutes: null,
  probes: [],
  minProbesPerCategory: 1,
  ...overrides,
})

const stateOf = (observed: readonly DefenseObservation[], defense: GamingDefense) =>
  observed.find(entry => entry.defense === defense)

describe('observeDefenses', () => {
  it('reports every defense unobserved while no record backs it', () => {
    const observed = observeDefenses(facts())
    expect(observed.map(entry => entry.defense)).toEqual([
      'multiple-evaluators',
      'hidden-holdout',
      'behavioral-metrics',
      'adversarial-tests',
      'randomized-tests',
      'evaluator-rotation',
    ])
    expect(stateOf(observed, 'multiple-evaluators')?.state).toBe('unobserved')
    expect(stateOf(observed, 'hidden-holdout')?.state).toBe('unobserved')
    expect(stateOf(observed, 'evaluator-rotation')?.state).toBe('unobserved')
    // The two the profile records itself read open, not unobserved.
    expect(stateOf(observed, 'behavioral-metrics')).toEqual({
      defense: 'behavioral-metrics',
      state: 'observed-open',
      evidence: '0 probe(s) exercised evaluator-gaming behavior',
    })
    expect(stateOf(observed, 'adversarial-tests')?.state).toBe('observed-open')
  })

  it('never claims randomized tests or human spot checks are checked', () => {
    const observed = observeDefenses(facts({
      strategies: [],
      holdouts: ['writer'],
      evaluationRoutes: [],
      probes: [probe('edge-case')],
    }))
    expect(stateOf(observed, 'randomized-tests')).toEqual({
      defense: 'randomized-tests',
      state: 'unobserved',
      evidence: 'nothing records which tests were randomized; randomized tests and human spot checks stay operator-side',
    })
  })

  it('reads multiple evaluators from the independent verdicts recorded per evaluator', () => {
    const one = observeDefenses(facts({
      strategies: [
        { evaluator: 'scorer-v1', taskClass: 'writer', independentSamples: 3 },
        { evaluator: 'self-judge', taskClass: 'planner', independentSamples: 0 },
      ],
    }))
    expect(stateOf(one, 'multiple-evaluators')).toEqual({
      defense: 'multiple-evaluators',
      state: 'observed-open',
      evidence: '1 evaluator(s) carry an independent verdict',
    })
    const two = observeDefenses(facts({
      strategies: [
        { evaluator: 'scorer-v1', taskClass: 'writer', independentSamples: 3 },
        { evaluator: 'ensemble-v2', taskClass: 'writer', independentSamples: 1 },
      ],
    }))
    expect(stateOf(two, 'multiple-evaluators')).toMatchObject({ state: 'observed-satisfied', evidence: '2 evaluator(s) carry an independent verdict' })
  })

  it('reads the hidden holdout from the protected benchmark partitions', () => {
    expect(stateOf(observeDefenses(facts({ holdouts: [] })), 'hidden-holdout')).toEqual({
      defense: 'hidden-holdout',
      state: 'observed-open',
      evidence: '0 capability(s) hold a protected holdout task',
    })
    expect(stateOf(observeDefenses(facts({ holdouts: ['writer'] })), 'hidden-holdout')).toEqual({
      defense: 'hidden-holdout',
      state: 'observed-satisfied',
      evidence: '1 capability(s) hold a protected holdout task',
    })
  })

  it('reads behavioral metrics from the probes that exercised evaluator gaming', () => {
    expect(stateOf(observeDefenses(facts({ probes: [probe('evaluator-gaming')] })), 'behavioral-metrics')).toEqual({
      defense: 'behavioral-metrics',
      state: 'observed-satisfied',
      evidence: '1 probe(s) exercised evaluator-gaming behavior',
    })
  })

  it('reads adversarial tests from a skill whose full §45 coverage is probed', () => {
    const partial = [probe('edge-case'), probe('prompt-injection')]
    expect(stateOf(observeDefenses(facts({ probes: partial })), 'adversarial-tests')).toMatchObject({
      state: 'observed-open',
      evidence: 'no probe skill covers every §45 category at 1 probe(s) each',
    })
    const covered = [
      probe('edge-case'),
      probe('prompt-injection'),
      probe('stale-memory'),
      probe('retrieval-trap'),
      probe('contradictory-evidence'),
      probe('tool-failure'),
      probe('ambiguous-instruction'),
      probe('evaluator-gaming'),
    ]
    expect(stateOf(observeDefenses(facts({ probes: covered })), 'adversarial-tests')).toMatchObject({
      state: 'observed-satisfied',
      evidence: '1 probe skill(s) cover every §45 category',
    })
    // Two probes per category are needed before the configured minimum is met.
    expect(stateOf(observeDefenses(facts({ probes: covered, minProbesPerCategory: 2 })), 'adversarial-tests'))
      .toMatchObject({ state: 'observed-open' })
  })

  it('reads evaluator rotation from the evaluation routes one task class recorded', () => {
    const rows = [
      { taskClass: 'writer', provider: 'deepseek', model: 'chat' },
      { taskClass: 'writer', provider: 'deepseek', model: 'chat' },
      { taskClass: 'planner', provider: 'deepseek', model: 'chat' },
    ]
    expect(stateOf(observeDefenses(facts({ evaluationRoutes: rows })), 'evaluator-rotation')).toEqual({
      defense: 'evaluator-rotation',
      state: 'observed-open',
      evidence: '0 task class(es) recorded two or more evaluation routes',
    })
    const rotated = [...rows, { taskClass: 'writer', provider: 'deepseek', model: 'reasoner' }]
    expect(stateOf(observeDefenses(facts({ evaluationRoutes: rotated })), 'evaluator-rotation')).toEqual({
      defense: 'evaluator-rotation',
      state: 'observed-satisfied',
      evidence: '1 task class(es) recorded two or more evaluation routes',
    })
  })
})
