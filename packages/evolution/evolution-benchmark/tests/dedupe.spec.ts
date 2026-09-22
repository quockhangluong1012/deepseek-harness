import { describe, expect, it } from 'vitest'
import { benchmarkHash, blocksDuplicate, dedupe, nextLadder, transitionState } from '../src/index.ts'
import type { BenchmarkInput } from '../src/index.ts'

const input = (task: string): BenchmarkInput => ({ capability: 'writer', task, gists: [], sourceSessions: [] })

describe('evolution benchmark dedupe', () => {
  it('content-addresses a task by its normalized text', () => {
    expect(benchmarkHash(input('  fix\n  the\nfailure  '))).toBe(benchmarkHash(input('fix the failure')))
    expect(benchmarkHash(input('a'))).not.toBe(benchmarkHash(input('b')))
  })

  it('splits candidates into admitted and duplicates', () => {
    const existing = new Set([benchmarkHash(input('fix the failure'))])
    const { admitted, duplicates } = dedupe([
      input('fix the failure'),
      input('new task'),
      input('fix the failure'),
      input('another one'),
    ], existing)
    expect(admitted.map(a => a.task)).toEqual(['new task', 'another one'])
    expect(duplicates).toEqual(['fix the failure', 'fix the failure'])
  })

  it('classifies learnable and terminal states', () => {
    expect(blocksDuplicate('fresh')).toBe(true)
    expect(blocksDuplicate('search')).toBe(true)
    expect(blocksDuplicate('validation')).toBe(true)
    expect(blocksDuplicate('holdout')).toBe(true)
    expect(blocksDuplicate('contaminated')).toBe(false)
    expect(blocksDuplicate('retired')).toBe(false)
  })

  it('walks one legal ladder step at a time and derails from any learnable state', () => {
    expect(transitionState('fresh', 'search')).toBe(true)
    expect(transitionState('search', 'validation')).toBe(true)
    expect(transitionState('validation', 'holdout')).toBe(true)
    expect(transitionState('fresh', 'validation')).toBe(false)
    expect(transitionState('holdout', 'search')).toBe(false)
    expect(transitionState('fresh', 'contaminated')).toBe(true)
    expect(transitionState('holdout', 'retired')).toBe(true)
    expect(transitionState('contaminated', 'fresh')).toBe(false)
    expect(transitionState('retired', 'search')).toBe(false)
    expect(transitionState('fresh', 'fresh')).toBe(true)
  })

  it('names the next promotion step and ends at the final learnable state', () => {
    expect(nextLadder('fresh')).toBe('search')
    expect(nextLadder('search')).toBe('validation')
    expect(nextLadder('validation')).toBe('holdout')
    expect(nextLadder('holdout')).toBeUndefined()
    expect(nextLadder('contaminated')).toBeUndefined()
    expect(nextLadder('retired')).toBeUndefined()
  })
})
