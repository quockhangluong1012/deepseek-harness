import { describe, expect, it } from 'vitest'
import { costUsd, spendOf, spendSince } from '../src/spend.ts'

/**
 * Behavior suite for the spend arithmetic: the billed-token split a ceiling
 * compares, the difference between two readings, and the flat price. Every
 * unavailable side must read as unmeasurable rather than as zero.
 */

const usage = {
  uncachedInputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
}

describe('spendOf', () => {
  it('bills prompt tokens as uncached input plus both cache buckets', () => {
    expect(spendOf(usage)).toEqual({ inputTokens: 15, outputTokens: 5, totalTokens: 20 })
  })

  it('reports a missing usage reading as unmeasurable, never as zero', () => {
    expect(spendOf(undefined)).toBeUndefined()
  })
})

describe('spendSince', () => {
  it('differences two readings bucket by bucket', () => {
    const origin = spendOf({ uncachedInputTokens: 4, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 })
    expect(spendSince(spendOf(usage), origin)).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 })
  })

  it('reads a revised sample that shrank below its origin as zero, never negative', () => {
    const origin = spendOf({ uncachedInputTokens: 30, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(spendSince(spendOf(usage), origin)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('is unmeasurable when either reading is missing', () => {
    expect(spendSince(undefined, spendOf(usage))).toBeUndefined()
    expect(spendSince(spendOf(usage), undefined)).toBeUndefined()
  })
})

describe('costUsd', () => {
  it('prices billed tokens at the deployment flat rate', () => {
    expect(costUsd({ inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 }, 2)).toBe(1)
  })

  it('is unmeasurable without a price or without a spend', () => {
    expect(costUsd({ inputTokens: 0, outputTokens: 0, totalTokens: 500_000 }, undefined)).toBeUndefined()
    expect(costUsd(undefined, 2)).toBeUndefined()
  })
})
