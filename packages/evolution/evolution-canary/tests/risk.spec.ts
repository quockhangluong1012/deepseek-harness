import { describe, expect, it } from 'vitest'
import { assessRisk } from '../src/index.ts'
import type { RiskInput } from '../src/index.ts'

const input = (overrides: Partial<RiskInput> = {}): RiskInput => ({
  artifact: 'skill',
  evidence: 'strong',
  reversible: true,
  holdout: true,
  ...overrides,
})

describe('evolution canary risk model', () => {
  it('grades each combination of artifact, evidence, reversibility, and holdout', () => {
    const table: readonly [string, RiskInput, { risk: string; route: string }][] = [
      // Low risk: strong evidence, an undoable change, and a covered holdout.
      ['skill/strong/reversible/holdout', input(), { risk: 'low', route: 'auto-promote' }],
      // No measurement: the evidence cannot decide the step at all.
      ['skill/none/reversible/holdout', input({ evidence: 'none' }), { risk: 'uncertain', route: 'human-review' }],
      ['memory/none/irreversible/uncovered', input({
        artifact: 'memory',
        evidence: 'none',
        reversible: false,
        holdout: false,
      }), { risk: 'uncertain', route: 'human-review' }],
      // One aggravation: memory, partial evidence, or no holdout.
      ['memory/strong/reversible/holdout', input({ artifact: 'memory' }), { risk: 'medium', route: 'canary' }],
      ['skill/partial/reversible/holdout', input({ evidence: 'partial' }), { risk: 'medium', route: 'canary' }],
      ['skill/strong/reversible/uncovered', input({ holdout: false }), { risk: 'medium', route: 'canary' }],
      // Two aggravations stack into high risk.
      ['memory/strong/reversible/uncovered', input({ artifact: 'memory', holdout: false }), {
        risk: 'high',
        route: 'human-approval',
      }],
      ['memory/partial/reversible/holdout', input({ artifact: 'memory', evidence: 'partial' }), {
        risk: 'high',
        route: 'human-approval',
      }],
      ['skill/partial/reversible/uncovered', input({ evidence: 'partial', holdout: false }), {
        risk: 'high',
        route: 'human-approval',
      }],
      // A change that cannot be undone is high however strong its evidence.
      ['skill/strong/irreversible/holdout', input({ reversible: false }), {
        risk: 'high',
        route: 'human-approval',
      }],
    ]
    for (const [name, riskInput, expected] of table) {
      expect(assessRisk(riskInput), name).toEqual(expected)
    }
  })
})
