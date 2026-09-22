import { describe, expect, it } from 'vitest'
import { bestOf, betterThan, generationsSince, strategyFor } from '../src/stagnation.ts'
import type { RunScore, StagnationRun } from '../src/types.ts'

const score = (overrides: Partial<RunScore> = {}): RunScore => ({
  pass: true,
  tokens: 10,
  wallTimeMs: 100,
  ...overrides,
})

const run = (overrides: Partial<StagnationRun>): StagnationRun => ({
  runId: 'r1',
  skill: 'writer',
  generation: 1,
  score: score(),
  improved: false,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('betterThan', () => {
  it('treats the first score of a skill as an improvement', () => {
    expect(betterThan(score(), null, 0.05)).toBe(true)
  })

  it('lets a pass gain dominate and refuses a pass loss', () => {
    const failing = score({ pass: false })
    expect(betterThan(score(), failing, 0.05)).toBe(true)
    expect(betterThan(failing, score(), 0.05)).toBe(false)
  })

  it('requires the relative token or wall-time gain floor', () => {
    const best = score({ tokens: 100, wallTimeMs: 1000 })
    // At least 5% fewer tokens counts; a 2% dip does not.
    expect(betterThan(score({ tokens: 95, wallTimeMs: 2000 }), best, 0.05)).toBe(true)
    expect(betterThan(score({ tokens: 98, wallTimeMs: 50 }), best, 0.05)).toBe(false)
    // With tokens unchanged, wall time must drop by the same floor.
    expect(betterThan(score({ tokens: 100, wallTimeMs: 950 }), best, 0.05)).toBe(true)
    expect(betterThan(score({ tokens: 100, wallTimeMs: 990 }), best, 0.05)).toBe(false)
    // More tokens is never an improvement, whatever the wall time.
    expect(betterThan(score({ tokens: 101, wallTimeMs: 1 }), best, 0.05)).toBe(false)
  })
})

describe('bestOf', () => {
  it('reports null for an empty list', () => {
    expect(bestOf([], 0.05)).toBeNull()
  })

  it('tracks the meaningful elite top without letting jitter move it', () => {
    const rows = [
      run({ runId: 'a', score: score({ pass: true, tokens: 100, wallTimeMs: 1000 }) }),
      // A 2% token dip is below the 5% floor and never nudges the best.
      run({ runId: 'b', score: score({ pass: true, tokens: 98, wallTimeMs: 50 }) }),
      run({ runId: 'c', score: score({ pass: false, tokens: 1, wallTimeMs: 1 }) }),
    ]
    expect(bestOf(rows, 0.05)).toEqual({ pass: true, tokens: 100, wallTimeMs: 1000 })
    expect(bestOf(rows, 0)).toEqual({ pass: true, tokens: 98, wallTimeMs: 50 })
  })

  it('moves to a run that clears the floor and keeps the elite tie order', () => {
    const rows = [
      run({ runId: 'a', score: score({ tokens: 100 }) }),
      run({ runId: 'b', score: score({ tokens: 95 }) }),
      run({ runId: 'x', score: score({ tokens: 95, wallTimeMs: 900 }) }),
    ]
    expect(bestOf(rows, 0.05)).toEqual({ pass: true, tokens: 95, wallTimeMs: 100 })
  })
})

describe('generationsSince', () => {
  it('counts every run when nothing improved and resets after an improvement', () => {
    const rows = [
      run({ runId: 'a', generation: 1 }),
      run({ runId: 'b', generation: 2 }),
      run({ runId: 'c', generation: 3, improved: true }),
      run({ runId: 'd', generation: 4 }),
      run({ runId: 'e', generation: 5 }),
    ]
    expect(generationsSince(rows)).toBe(2)
    expect(generationsSince(rows.slice(0, 2))).toBe(2)
    expect(generationsSince([])).toBe(0)
  })
})

describe('strategyFor', () => {
  it('keeps normal exploitation before the threshold', () => {
    expect(strategyFor(4, 5)).toBe('exploitation')
  })

  it('climbs one ladder rung per threshold span and caps at a new model', () => {
    expect(strategyFor(5, 5)).toBe('diversity')
    expect(strategyFor(10, 5)).toBe('newOperators')
    expect(strategyFor(15, 5)).toBe('newTasks')
    expect(strategyFor(20, 5)).toBe('newEvaluators')
    expect(strategyFor(25, 5)).toBe('newModel')
    expect(strategyFor(60, 5)).toBe('newModel')
  })
})
