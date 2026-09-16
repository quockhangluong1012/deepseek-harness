/**
 * The frontier ranking without a host: groups, ordering, archived exclusion,
 * and row rendering.
 */
import { describe, expect, it } from 'vitest'
import { rankFrontier } from '../src/frontier.ts'
import type { FrontierInput } from '../src/frontier.ts'

function input(name: string, overrides: Partial<FrontierInput> = {}): FrontierInput {
  return {
    name,
    archived: false,
    useCount: 0,
    failureCount: 0,
    trustFailures: 0,
    sessions: 0,
    winner: null,
    topFailure: null,
    ...overrides,
  }
}

function passing(tokens: number, confidence: { wins: number; runs: number } | null = null) {
  return { pass: true, tokens, confidence }
}

describe('rankFrontier', () => {
  it('orders failing without a passing winner, then unmeasured, then passing', () => {
    const rows = rankFrontier([
      input('passing', { winner: passing(100, { wins: 1, runs: 1 }) }),
      input('quiet'),
      input('broken', { failureCount: 2, winner: { pass: false, tokens: 50, confidence: null } }),
      input('old', { archived: true, failureCount: 9 }),
    ])
    expect(rows.map(row => row.name)).toEqual(['broken', 'quiet', 'passing'])
  })

  it('breaks failing ties by name in either input order', () => {
    const expected = ['a-mid', 'm-mid']
    // A two-element sort calls the comparator exactly once; both orders
    // together prove both arms of the name tiebreak.
    expect(rankFrontier([input('m-mid', { failureCount: 2 }), input('a-mid', { trustFailures: 2 })]).map(row => row.name))
      .toEqual(expected)
    expect(rankFrontier([input('a-mid', { trustFailures: 2 }), input('m-mid', { failureCount: 2 })]).map(row => row.name))
      .toEqual(expected)
  })

  it('sorts failing skills by failures, then by name', () => {
    const rows = rankFrontier([
      input('b-second', { failureCount: 2 }),
      input('a-first', { trustFailures: 3 }),
      input('c-last', { failureCount: 1, winner: { pass: false, tokens: 10, confidence: null } }),
    ])
    expect(rows.map(row => [row.name, row.failures])).toEqual([
      ['a-first', 3],
      ['b-second', 2],
      ['c-last', 1],
    ])
  })

  it('keeps a failing skill with a passing winner among the passing', () => {
    const rows = rankFrontier([
      input('recovered', { failureCount: 4, winner: passing(200, { wins: 1, runs: 1 }) }),
      input('quiet'),
    ])
    expect(rows.map(row => row.name)).toEqual(['quiet', 'recovered'])
  })

  it('sorts passing skills by confirmation, then tally, then cost', () => {
    const rows = rankFrontier([
      input('cheap-confirmed', { winner: passing(100, { wins: 4, runs: 5 }) }),
      input('unconfirmed', { winner: passing(9000) }),
      input('costly-confirmed', { winner: passing(500, { wins: 1, runs: 1 }) }),
      input('weak-tally', { winner: passing(100, { wins: 1, runs: 3 }) }),
    ])
    expect(rows.map(row => row.name)).toEqual([
      'unconfirmed',
      'weak-tally',
      'costly-confirmed',
      'cheap-confirmed',
    ])
  })

  it('sorts unmeasured skills by name in either input order', () => {
    const expected = ['a-quiet', 'b-quiet']
    expect(rankFrontier([input('b-quiet'), input('a-quiet')]).map(row => row.name)).toEqual(expected)
    expect(rankFrontier([input('a-quiet'), input('b-quiet')]).map(row => row.name)).toEqual(expected)
  })

  it('orders two unconfirmed passes by cost', () => {
    const rows = rankFrontier([
      input('cheap-guess', { winner: passing(100) }),
      input('costly-guess', { winner: passing(500) }),
    ])
    expect(rows.map(row => row.name)).toEqual(['costly-guess', 'cheap-guess'])
  })

  it('breaks identical twins by name in either input order', () => {
    const twin = (name: string) => input(name, { winner: passing(100, { wins: 2, runs: 4 }) })
    const expected = ['a-twin', 'b-twin']
    expect(rankFrontier([twin('b-twin'), twin('a-twin')]).map(row => row.name)).toEqual(expected)
    expect(rankFrontier([twin('a-twin'), twin('b-twin')]).map(row => row.name)).toEqual(expected)
  })

  it('breaks equal tallies by cost, then by name', () => {
    const rows = rankFrontier([
      input('costly-twin', { winner: passing(500, { wins: 2, runs: 4 }) }),
      input('cheap-twin', { winner: passing(100, { wins: 2, runs: 4 }) }),
      input('b-twin', { winner: passing(100, { wins: 2, runs: 4 }) }),
      input('a-twin', { winner: passing(100, { wins: 2, runs: 4 }) }),
    ])
    expect(rows.map(row => row.name)).toEqual(['costly-twin', 'a-twin', 'b-twin', 'cheap-twin'])
  })

  it('renders scores, tallies, failures, and coverage on the row', () => {
    const [row] = rankFrontier([
      input('writer', {
        description: 'Writes files',
        useCount: 12,
        failureCount: 3,
        trustFailures: 1,
        sessions: 2,
        winner: { pass: false, tokens: 800, confidence: { wins: 2, runs: 5 } },
        topFailure: 'command not found',
      }),
    ])
    expect(row).toEqual({
      name: 'writer',
      description: 'Writes files',
      score: 'fail at 800 tokens',
      confidence: '2/5',
      failures: 4,
      topFailure: 'command not found',
      loads: 12,
      sessions: 2,
    })
  })
  it('renders unmeasured rows without a tally', () => {
    const [row] = rankFrontier([input('fresh')])
    expect(row?.score).toBe('unmeasured')
    expect(row?.confidence).toBeNull()
    expect(row?.failures).toBe(0)
  })
})
