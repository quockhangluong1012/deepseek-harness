import { describe, expect, it } from 'vitest'
import { orderStaged } from '../src/stage.ts'

/** One staged row with only the ordering fields varied. */
function row(name: string, failureRate: number) {
  return { name, useCount: 1, failureCount: 4, failureRate, reason: 'reason' }
}

describe('staged ordering', () => {
  it('orders by failure rate descending', () => {
    expect(orderStaged([row('mild', 0.4), row('severe', 0.9)]).map(r => r.name)).toEqual(['severe', 'mild'])
  })

  it('breaks an equal rate by ascending name in either input order', () => {
    // A two-element array makes the comparator run once per direction, so both
    // arms of the name tie-break are exercised whatever the sort does.
    expect(orderStaged([row('beta', 0.5), row('alpha', 0.5)]).map(r => r.name)).toEqual(['alpha', 'beta'])
    expect(orderStaged([row('alpha', 0.5), row('beta', 0.5)]).map(r => r.name)).toEqual(['alpha', 'beta'])
  })
})
