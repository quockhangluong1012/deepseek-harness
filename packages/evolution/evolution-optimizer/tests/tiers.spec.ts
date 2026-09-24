/**
 * Batch-id helpers behind the S9 tier-2 ceiling gate: a day is UTC calendar
 * date, a week is ISO-8601 (Monday-based), including the boundary cases a
 * naive week-of-year formula gets wrong — a week that crosses the new year,
 * and a year that carries a 53rd week.
 */
import { describe, expect, it } from 'vitest'
import { dailyBatchId, weeklyBatchId } from '../src/tiers.ts'

describe('dailyBatchId', () => {
  it('keys by the UTC calendar date', () => {
    expect(dailyBatchId('writer', new Date('2024-06-15T23:59:00Z'))).toBe('evolution-optimizer:writer:daily:2024-06-15')
  })
})

describe('weeklyBatchId', () => {
  it('keys a Monday-start week the plain year-of-date agrees with', () => {
    expect(weeklyBatchId('writer', new Date('2024-01-01T00:00:00Z'))).toBe('evolution-optimizer:writer:weekly:2024-W01')
  })

  it('assigns an early-January date to the prior ISO year’s last week', () => {
    // 2023-01-01 is a Sunday: ISO calendar puts it in 2022's week 52.
    expect(weeklyBatchId('writer', new Date('2023-01-01T00:00:00Z'))).toBe('evolution-optimizer:writer:weekly:2022-W52')
  })

  it('reaches a 53rd week in a year that has one', () => {
    expect(weeklyBatchId('writer', new Date('2026-12-28T00:00:00Z'))).toBe('evolution-optimizer:writer:weekly:2026-W53')
  })

  it('carries the same key across the whole week regardless of weekday', () => {
    const monday = weeklyBatchId('writer', new Date('2024-06-10T00:00:00Z'))
    const sunday = weeklyBatchId('writer', new Date('2024-06-16T23:59:00Z'))
    expect(monday).toBe(sunday)
  })
})
