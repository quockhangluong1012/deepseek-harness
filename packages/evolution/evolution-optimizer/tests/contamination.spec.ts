/**
 * Holdout contamination: the holdout scenarios a skill's recorded runs already
 * searched are not clean, everything else is. Pure, so specs drive it without
 * a storage backend.
 */
import { describe, expect, it } from 'vitest'
import { contaminatedHoldout } from '../src/contamination.ts'
import type { ExperimentRecord } from '../src/types.ts'

function row(scenarios: readonly string[], holdout: readonly string[] = []): ExperimentRecord {
  return {
    id: 'row',
    at: '2026-09-15T10:00:00.000Z',
    scope: 'profile:ws',
    skill: 'writer',
    evidence: 'evidence',
    operators: ['rewrite'],
    portfolio: ['rewrite'],
    novelOperators: [],
    scenarios: [...scenarios],
    holdout: [...holdout],
    baseline: { pass: true, tokens: 10, wallTimeMs: 5 },
    winner: null,
    confidence: null,
    samples: 1,
    outcome: 'no-improvement',
    reason: null,
    stagedId: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    bodySha: 'sha',
    scorerVersion: 1,
    addedLines: 0,
    removedLines: 0,
    winnerSha: null,
    winnerOperator: null,
  }
}

describe('contaminatedHoldout', () => {
  it('reports nothing when the skill never searched', () => {
    expect(contaminatedHoldout([], ['s1'])).toEqual([])
    expect(contaminatedHoldout([row(['s2'])], ['s1'])).toEqual([])
  })

  it('names the holdout scenarios the skill already searched, in holdout order', () => {
    const rows = [row(['s1', 's2']), row(['s3'])]
    expect(contaminatedHoldout(rows, ['s3', 's1', 'h1'])).toEqual(['s3', 's1'])
  })

  it('ignores scenarios only ever checked as holdout, never searched', () => {
    const rows = [row(['s1'], ['h1'])]
    expect(contaminatedHoldout(rows, ['h1'])).toEqual([])
  })
})
