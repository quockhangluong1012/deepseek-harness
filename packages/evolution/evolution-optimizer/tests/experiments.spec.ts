/**
 * Ledger selection: which rows a scope keeps, which ones a read returns, and
 * how ties and limits resolve. Pure, so specs drive the arithmetic without a
 * storage backend.
 */
import { describe, expect, it } from 'vitest'
import { describeOutcome, experimentKey, experimentPage, hasResult, repeatedExperiment, staleExperiments } from '../src/experiments.ts'
import type { ExperimentRecord } from '../src/types.ts'

function row(id: string, at: string, scope = 'profile:ws', skill = 'writer'): ExperimentRecord {
  return {
    id,
    at,
    scope,
    skill,
    evidence: 'evidence',
    operators: ['rewrite'],
    portfolio: ['rewrite'],
    novelOperators: [],
    scenarios: ['s1'],
    holdout: [],
    baseline: { pass: true, tokens: 10, wallTimeMs: 5 },
    winner: null,
    confidence: null,
    samples: 3,
    outcome: 'no-improvement',
    reason: 'no variant beats the baseline',
    stagedId: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    bodySha: 'sha',
    winnerSha: null,
    winnerOperator: null,
  }
}

describe('experimentPage', () => {
  it('returns the scope newest first and honours the query limit', () => {
    const rows = [row('a', '2026-09-15T10:00:00.000Z'), row('b', '2026-09-15T11:00:00.000Z')]
    expect(experimentPage(rows, 'profile:ws', {}, 20).map(entry => entry.id)).toEqual(['b', 'a'])
    expect(experimentPage(rows, 'profile:ws', { limit: 1 }, 20).map(entry => entry.id)).toEqual(['b'])
    expect(experimentPage(rows, 'profile:ws', {}, 1).map(entry => entry.id)).toEqual(['b'])
  })

  it('filters by scope and skill, and breaks a same-instant tie by id', () => {
    const rows = [
      row('a', '2026-09-15T10:00:00.000Z'),
      row('z', '2026-09-15T10:00:00.000Z'),
      row('c', '2026-09-15T10:00:00.000Z', 'profile:ws', 'other'),
      row('d', '2026-09-15T10:00:00.000Z', 'profile:elsewhere'),
    ]
    expect(experimentPage(rows, 'profile:ws', {}, 20).map(entry => entry.id)).toEqual(['a', 'c', 'z'])
    expect(experimentPage(rows, 'profile:ws', { skill: 'writer' }, 20).map(entry => entry.id)).toEqual(['a', 'z'])
    expect(experimentPage(rows, 'profile:ws', { skill: 'other' }, 20).map(entry => entry.id)).toEqual(['c'])
  })
})

describe('experimentKey', () => {
  it('names one hypothesis independent of scenario and operator ordering', () => {
    const base = {
      skill: 'writer',
      evidence: 'evidence',
      scenarios: ['s1', 's2'],
      portfolio: ['rewrite', 'compress'],
      bodySha: 'sha',
      provider: 'deepseek',
      model: 'deepseek-chat',
    }
    const same = experimentKey({ ...base, scenarios: ['s2', 's1'], portfolio: ['compress', 'rewrite'] })
    expect(same).toBe(experimentKey(base))
    expect(experimentKey({ ...base, evidence: 'other' })).not.toBe(same)
    expect(experimentKey({ ...base, scenarios: ['s1'] })).not.toBe(same)
    expect(experimentKey({ ...base, portfolio: ['rewrite'] })).not.toBe(same)
    expect(experimentKey({ ...base, bodySha: 'other' })).not.toBe(same)
    expect(experimentKey({ ...base, model: 'deepseek-reasoner' })).not.toBe(same)
  })

  it('reads a key back off a recorded row', () => {
    const parts = {
      skill: 'writer',
      evidence: 'evidence',
      scenarios: ['s1'],
      portfolio: ['rewrite'],
      bodySha: 'sha',
      provider: 'deepseek',
      model: 'deepseek-chat',
    }
    expect(experimentKey(row('a', '2026-09-15T10:00:00.000Z'))).toBe(experimentKey(parts))
  })
})

describe('repeatedExperiment', () => {
  it('finds the newest run of the same experiment and names its outcome', () => {
    const parts = {
      skill: 'writer',
      evidence: 'evidence',
      scenarios: ['s1'],
      portfolio: ['rewrite'],
      bodySha: 'sha',
      provider: 'deepseek',
      model: 'deepseek-chat',
    }
    const key = experimentKey(parts)
    const older = row('a', '2026-09-15T10:00:00.000Z')
    const newer = { ...row('b', '2026-09-15T11:00:00.000Z'), outcome: 'staged' as const, stagedId: 'staged-0' }
    expect(repeatedExperiment([newer, older], key)).toEqual(newer)
    expect(describeOutcome(newer)).toBe('it staged a promotion')
    expect(repeatedExperiment([older], experimentKey({ ...parts, evidence: 'other' }))).toBeUndefined()
  })

  it('does not remember a run that never evaluated', () => {
    const unevaluated = { ...row('a', '2026-09-15T10:00:00.000Z'), baseline: null }
    expect(hasResult(unevaluated)).toBe(false)
    expect(hasResult(row('b', '2026-09-15T10:00:00.000Z'))).toBe(true)
    expect(repeatedExperiment([unevaluated], experimentKey(unevaluated))).toBeUndefined()
  })
})

describe('staleExperiments', () => {
  it('drops nothing while the cap is met and the oldest rows past it when it is not', () => {
    const rows = [
      row('b', '2026-09-15T11:00:00.000Z'),
      row('a', '2026-09-15T10:00:00.000Z'),
      row('c', '2026-09-15T12:00:00.000Z'),
    ]
    expect(staleExperiments(rows, 3)).toEqual([])
    expect(staleExperiments(rows, 1).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('breaks a same-instant tie by id when choosing what to drop', () => {
    const rows = [row('b', '2026-09-15T10:00:00.000Z'), row('a', '2026-09-15T10:00:00.000Z')]
    expect(staleExperiments(rows, 1).map(entry => entry.id)).toEqual(['a'])
  })
})
