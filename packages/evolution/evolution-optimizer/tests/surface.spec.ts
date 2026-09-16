/**
 * Failure surfaces: the signature folds telemetry magnitudes away, the records
 * count tries and wins per operator, and the lineup follows that record —
 * winners first, untried next, only-ever-losers last.
 */
import { describe, expect, it } from 'vitest'
import { failureSignature, operatorRecords, orderPortfolio } from '../src/surface.ts'
import { resolveOperators } from '../src/mutate.ts'
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
    winnerSha: null,
    winnerOperator: null,
    ...overrides,
  }
}

describe('failureSignature', () => {
  it('folds magnitudes so recurring failures share one signature', () => {
    expect(failureSignature('3 failures over 20 recorded loads'))
      .toBe(failureSignature('11 FAILURES   over 204 recorded loads'))
    expect(failureSignature('3 failures over 20 recorded loads'))
      .not.toBe(failureSignature('3 failures on the writer skill'))
    expect(failureSignature('   ')).toBe('')
  })
})

describe('operatorRecords', () => {
  it('counts a try per producing operator and a win for the promoting one', () => {
    const rows = [
      row({ id: 'a', operators: ['rewrite', 'guard'], novelOperators: ['guard'], winnerOperator: 'guard', outcome: 'staged' }),
      row({ id: 'b', operators: ['rewrite'], winnerOperator: null }),
      row({ id: 'c', evidence: 'other failure', operators: ['compress'], winnerOperator: 'compress', outcome: 'staged' }),
      row({ id: 'd', baseline: null, operators: ['compress'], winnerOperator: 'compress' }),
    ]
    expect(operatorRecords(rows, failureSignature('3 failures over 20 recorded loads')))
      .toEqual([
        { operator: 'guard', tries: 1, wins: 1, fresh: true },
        { operator: 'rewrite', tries: 2, wins: 0, fresh: false },
      ])
  })
})

describe('orderPortfolio', () => {
  const portfolio = resolveOperators(['rewrite', 'compress', 'guard', 'exemplify'])
  const portfolioFor = (ids: readonly string[]) => resolveOperators(ids)

  it('puts measured winners first, untried next, and only-losers last', () => {
    const records = [
      { operator: 'guard', tries: 4, wins: 1, fresh: true },
      { operator: 'compress', tries: 2, wins: 2, fresh: true },
      { operator: 'rewrite', tries: 5, wins: 0, fresh: true },
    ]
    expect(orderPortfolio(portfolio, records, 2).map(operator => operator.id))
      .toEqual(['compress', 'guard', 'exemplify', 'rewrite'])
  })

  it('ignores a record below the try threshold and keeps configuration order otherwise', () => {
    const records = [
      { operator: 'guard', tries: 1, wins: 1, fresh: true },
      { operator: 'compress', tries: 3, wins: 1, fresh: true },
    ]
    // guard's single try does not order anything, so it stays where it was configured.
    expect(orderPortfolio(portfolio, records, 2).map(operator => operator.id))
      .toEqual(['compress', 'rewrite', 'guard', 'exemplify'])
    expect(orderPortfolio(portfolio, [], 1).map(operator => operator.id))
      .toEqual(['rewrite', 'compress', 'guard', 'exemplify'])
  })

  it('ranks winners by rate and only-losers by freshness then how often they were tried', () => {
    const records = [
      { operator: 'rewrite', tries: 4, wins: 2, fresh: true },
      { operator: 'guard', tries: 2, wins: 2, fresh: true },
      { operator: 'compress', tries: 2, wins: 0, fresh: true },
      { operator: 'exemplify', tries: 6, wins: 0, fresh: false },
    ]
    // compress restated the body fewer times than exemplify, so it goes first
    // among the losers even though exemplify was tried more.
    expect(orderPortfolio(portfolio, records, 2).map(operator => operator.id))
      .toEqual(['guard', 'rewrite', 'compress', 'exemplify'])
  })

  it('prefers the loser that was tried more when neither said anything new', () => {
    const records = [
      { operator: 'rewrite', tries: 5, wins: 0, fresh: false },
      { operator: 'guard', tries: 2, wins: 0, fresh: false },
    ]
    expect(orderPortfolio(portfolio, records, 1).map(operator => operator.id))
      .toEqual(['compress', 'exemplify', 'rewrite', 'guard'])
  })

  it('keeps an operator that never said anything new behind one that did', () => {
    const records = [
      { operator: 'rewrite', tries: 5, wins: 0, fresh: false },
      { operator: 'guard', tries: 1, wins: 0, fresh: true },
    ]
    // Untried operators still come first: this orders the two that were tried.
    expect(orderPortfolio(portfolio, records, 1).map(operator => operator.id))
      .toEqual(['compress', 'exemplify', 'guard', 'rewrite'])
  })

  it('breaks an equal record by configuration order', () => {
    const tied = [
      { operator: 'rewrite', tries: 2, wins: 1, fresh: true },
      { operator: 'guard', tries: 4, wins: 2, fresh: true },
      { operator: 'compress', tries: 3, wins: 0, fresh: true },
      { operator: 'exemplify', tries: 3, wins: 0, fresh: true },
    ]
    // Same win rate and same zero-win try count, on both sides of the tie: the
    // configured order decides.
    expect(orderPortfolio(portfolio, tied, 1).map(operator => operator.id))
      .toEqual(['rewrite', 'guard', 'compress', 'exemplify'])
  })

  it('orders a narrowed lineup without inventing operators', () => {
    const narrowed = portfolioFor(['compress', 'rewrite'])
    const records = [{ operator: 'compress', tries: 3, wins: 2, fresh: true }]
    expect(orderPortfolio(narrowed, records, 1).map(operator => operator.id))
      .toEqual(['compress', 'rewrite'])
  })
})
