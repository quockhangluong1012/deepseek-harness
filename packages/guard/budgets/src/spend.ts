/**
 * Billed-token spend and its price, as the axes a ceiling bounds read it. The
 * token meter owns tokens and the deployment owns the price, so this module
 * turns the meter's usage projection into the number a ceiling compares and
 * reports an unavailable side as unmeasurable rather than as zero.
 * @module @deepseek-ai/dsh-budgets/spend
 */

import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'

/** Billed tokens one scope spent, split by the axis a ceiling bounds. */
export interface Spend {
  /** Prompt tokens: uncached input plus cache reads and writes. */
  readonly inputTokens: number
  /** Completion tokens, reasoning included. */
  readonly outputTokens: number
  /** All billed tokens, prompt plus completion. */
  readonly totalTokens: number
}

/** The token meter's billed-token buckets for one session, as its `tokenUsage` projection reports them. */
export type BilledUsage = SessionProjectionMap['tokenUsage']

/**
 * Billed spend from one usage reading.
 * @param usage - the meter's billed buckets, or undefined when no reading exists.
 * @returns the split spend, or undefined when there is nothing to read.
 */
export function spendOf(usage: BilledUsage | undefined): Spend | undefined {
  if (usage === undefined) return undefined
  const inputTokens = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return { inputTokens, outputTokens: usage.outputTokens, totalTokens: inputTokens + usage.outputTokens }
}

/**
 * The spend between two readings of one session: what a turn, session, or run
 * ceiling bounds. A missing reading on either side is unmeasurable. A step
 * whose replacement revises its own sample downward can make the difference
 * negative, which reads as zero: no scope spends fewer than zero tokens.
 * @param now - the session's current spend.
 * @param origin - its spend when the scope opened, or undefined when the scope has no reading.
 * @returns the spend since that origin, or undefined when either side is unavailable.
 */
export function spendSince(now: Spend | undefined, origin: Spend | undefined): Spend | undefined {
  if (now === undefined || origin === undefined) return undefined
  return {
    inputTokens: Math.max(0, now.inputTokens - origin.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - origin.outputTokens),
    totalTokens: Math.max(0, now.totalTokens - origin.totalTokens),
  }
}

/**
 * Price billed spend at one flat price. The harness owns no per-route price
 * data, so a deployment prices its tokens itself; see this package's README.
 * @param spend - the billed spend to price.
 * @param usdPerMillionTokens - the deployment's price of one million billed tokens, or undefined when unpriced.
 * @returns the spend in USD, or undefined when either side is unavailable.
 */
export function costUsd(spend: Spend | undefined, usdPerMillionTokens: number | undefined): number | undefined {
  if (spend === undefined || usdPerMillionTokens === undefined) return undefined
  return (spend.totalTokens * usdPerMillionTokens) / 1_000_000
}
