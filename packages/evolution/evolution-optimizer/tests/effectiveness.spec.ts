/**
 * Operator effectiveness: attempts and acceptances follow the ledger, the
 * mean delta averages only winning rows, and the regression rate blames every
 * operator that produced a candidate in a regressed run.
 */
import { describe, expect, it } from 'vitest'
import { failureSignature, operatorEffectiveness } from '../src/surface.ts'
import type { ExperimentRecord } from '../src/types.ts'

function row(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    id: 'row',
    at: '2026-09-15T10:00:00.000Z',
    scope: 'profile:ws',
    skill: 'writer',
    evidence: '3 failures over 20 recorded loads',
    operators: ['rewrite'],
    portfolio: ['rewrite'],
    novelOperators: [],
    scenarios: ['s1'],
    holdout: [],
    baseline: { pass: false, tokens: 10, wallTimeMs: 5 },
    winner: null,
    confidence: null,
    samples: 1,
    outcome: 'no-improvement',
    reason: null,
    stagedId: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    bodySha: 'sha',
    ...overrides,
  } as ExperimentRecord
}

const signature = failureSignature('3 failures over 20 recorded loads')

describe('operatorEffectiveness', () => {
  it('counts attempts and acceptances per operator under one signature', () => {
    const rows = [
      row({
        id: 'a',
        operators: ['rewrite', 'guard'],
        winnerOperator: 'guard',
        winner: { pass: true, tokens: 6, wallTimeMs: 5 },
        outcome: 'staged',
      }),
      row({ id: 'b', operators: ['rewrite'] }),
      row({
        id: 'c',
        evidence: 'other failure',
        operators: ['compress'],
        winnerOperator: 'compress',
        winner: { pass: true, tokens: 4, wallTimeMs: 5 },
        outcome: 'staged',
      }),
      row({ id: 'd', baseline: null, operators: ['compress'], winnerOperator: 'compress' }),
    ]
    expect(operatorEffectiveness(rows, signature)).toEqual([
      { operator: 'guard', attempts: 1, accepted: 1, meanDelta: 4, regressionRate: 0 },
      { operator: 'rewrite', attempts: 2, accepted: 0, meanDelta: null, regressionRate: 0 },
    ])
  })

  it('averages the token saving across wins and blames regressed runs', () => {
    const rows = [
      row({
        id: 'a',
        operators: ['guard'],
        winnerOperator: 'guard',
        winner: { pass: true, tokens: 6, wallTimeMs: 5 },
        outcome: 'staged',
      }),
      row({
        id: 'b',
        operators: ['guard'],
        baseline: { pass: false, tokens: 20, wallTimeMs: 5 },
        winnerOperator: 'guard',
        winner: { pass: true, tokens: 14, wallTimeMs: 5 },
        outcome: 'staged',
      }),
      row({ id: 'c', operators: ['guard', 'rewrite'], outcome: 'regressed' }),
    ]
    expect(operatorEffectiveness(rows, signature)).toEqual([
      { operator: 'guard', attempts: 3, accepted: 2, meanDelta: 5, regressionRate: 1 / 3 },
      { operator: 'rewrite', attempts: 1, accepted: 0, meanDelta: null, regressionRate: 1 },
    ])
  })

  it('ignores a win without a measured triple and survives a winner outside the lineup', () => {
    const rows = [
      row({ id: 'a', operators: ['guard'], winnerOperator: 'guard', winner: null, outcome: 'staged' }),
      row({
        id: 'b',
        operators: [],
        portfolio: [],
        winnerOperator: 'ghost',
        winner: { pass: true, tokens: 6, wallTimeMs: 5 },
        outcome: 'staged',
      }),
    ]
    expect(operatorEffectiveness(rows, signature)).toEqual([
      { operator: 'ghost', attempts: 0, accepted: 1, meanDelta: 4, regressionRate: 0 },
      { operator: 'guard', attempts: 1, accepted: 0, meanDelta: null, regressionRate: 0 },
    ])
  })
})
