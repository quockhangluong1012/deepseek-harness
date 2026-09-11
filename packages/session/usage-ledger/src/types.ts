/**
 * Shared usage-ledger vocabulary: the filter range, per-day and per-model
 * aggregates, and the summary the ledger serves. Types only — no runtime code.
 * @module @deepseek-ai/dsh-usage-ledger/src/types
 */

/** Cross-session aggregation window selected by the dashboard filter. */
export type UsageRange = 'today' | '7d' | '30d' | 'all'

/** Totals over one summary window. */
export interface UsageTotals {
  /** Billed attempts (every usage sample counts, retries included). */
  readonly requests: number
  /** Billed prompt tokens. */
  readonly inputTokens: number
  /** Billed completion tokens. */
  readonly outputTokens: number
  /** Prompt tokens served from cache. */
  readonly cacheReadTokens: number
  /** Share of billed input served from cache, `0` without billed input. */
  readonly cacheHitAvg: number
}

/** One calendar day (UTC+7) of billed usage for the stacked bar chart. */
export interface UsageDayBucket {
  /** Calendar day in `YYYY-MM-DD` (UTC+7). */
  readonly day: string
  /** Billed attempts that day. */
  readonly requests: number
  /** Billed prompt tokens that day. */
  readonly inputTokens: number
  /** Billed completion tokens that day. */
  readonly outputTokens: number
}

/** One provider/model row of the model breakdown table. */
export interface UsageModelRow {
  /** Adapter provider name. */
  readonly provider: string
  /** Model name. */
  readonly model: string
  /** Billed attempts on this route. */
  readonly requests: number
  /** Billed prompt tokens on this route. */
  readonly inputTokens: number
  /** Billed completion tokens on this route. */
  readonly outputTokens: number
  /** Share of this route's billed input served from cache. */
  readonly cacheHitAvg: number
}

/** The complete dashboard answer for one filter range. */
export interface UsageSummary {
  /** The range this summary was computed for. */
  readonly range: UsageRange
  /** Window totals for the stat cards. */
  readonly totals: UsageTotals
  /** Per-day buckets for the bar chart, ascending by day. */
  readonly daily: readonly UsageDayBucket[]
  /** Per-model rows, descending by billed total. */
  readonly models: readonly UsageModelRow[]
}
