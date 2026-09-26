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

/**
 * One agent's or subagent's spend in one summary window: the session that
 * committed the attempts, its estimated money, and the routes no declared
 * price covered. A session that priced nothing reports `usd` as `undefined` —
 * unmeasurable, never zero — so a caller can tell "spent nothing measurable"
 * apart from "could not measure".
 */
export interface UsageSessionCost {
  /** Session id: the invoking agent or one of its subagents. */
  readonly sessionId: string
  /**
   * Estimated USD over the attempts priced through declared rates, or
   * `undefined` when no attempt could be priced. Attempts counted in
   * {@link unpricedRequests} contribute no money, so a mixed session reports
   * a lower bound and names what it could not cover.
   */
  readonly usd: number | undefined
  /** Attempts priced through a route that declared USD rates. */
  readonly pricedRequests: number
  /** Attempts no declared price covers, including steps whose route never settled. */
  readonly unpricedRequests: number
  /** Distinct routes with at least one unpriced attempt, ascending, as `provider/model`. */
  readonly unpricedRoutes: readonly string[]
}
