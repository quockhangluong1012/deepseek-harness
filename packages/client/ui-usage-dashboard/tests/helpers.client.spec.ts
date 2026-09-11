/**
 * The dashboard's display helpers: count grouping, cache-hit percent,
 * billed-input reading, and stacked bar geometry.
 */
import { describe, expect, it } from 'vitest'
import { barHeights, formatCacheHit, formatCount, maxDayTotal } from '../src/client/display.tsx'
import { billedInputOf } from '../src/client/UsageDashboard.tsx'

describe('dashboard display helpers', () => {
  it('groups large counts', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1300)).toBe('1,300')
  })

  it('renders cache-hit percent with one decimal', () => {
    expect(formatCacheHit(0)).toBe('0.0%')
    expect(formatCacheHit(1)).toBe('100.0%')
    expect(formatCacheHit(20 / 130)).toBe('15.4%')
  })

  it('reads billed input from the usage projection', () => {
    expect(billedInputOf({ uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10 })).toBe(130)
  })

  it('scales stacked segments to the window maximum', () => {
    const bucket = { day: '2026-09-09', requests: 1, inputTokens: 60, outputTokens: 40 }
    const { input, output } = barHeights(bucket, 100, 96)
    expect(input).toBeCloseTo(57.6)
    expect(output).toBeCloseTo(38.4)
    expect(barHeights(bucket, 0, 96)).toEqual({ input: 0, output: 0 })
    expect(barHeights({ day: '2026-09-09', requests: 0, inputTokens: 0, outputTokens: 0 }, 100, 96))
      .toEqual({ input: 0, output: 0 })
  })

  it('keeps a one-pixel minimum for a nonzero segment', () => {
    const bucket = { day: '2026-09-09', requests: 1, inputTokens: 1, outputTokens: 9999 }
    const { input, output } = barHeights(bucket, 10000, 96)
    expect(input).toBe(1)
    expect(output).toBeCloseTo(95.9904)
  })

  it('draws nothing for an empty segment', () => {
    expect(barHeights({ day: '2026-09-09', requests: 1, inputTokens: 0, outputTokens: 50 }, 50, 96))
      .toEqual({ input: 0, output: 96 })
  })

  it('takes the largest stacked day total', () => {
    expect(maxDayTotal([])).toBe(0)
    expect(maxDayTotal([
      { day: '2026-09-08', requests: 1, inputTokens: 60, outputTokens: 40 },
      { day: '2026-09-09', requests: 2, inputTokens: 10, outputTokens: 5 },
    ])).toBe(100)
  })
})
