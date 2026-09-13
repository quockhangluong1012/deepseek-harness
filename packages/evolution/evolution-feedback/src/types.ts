/**
 * Public vocabulary of the evolution feedback store: one observed failure,
 * the durable per-session record, and the aggregation the learning loop reads.
 * @module @deepseek-ai/dsh-evolution-feedback/src/types
 */

/**
 * One observed failure, deduplicated within its session by tool and message.
 * A repeat increments `count` and moves the entry to the front instead of
 * appending a second copy.
 */
export interface FeedbackEntry {
  /** Tool whose call failed, or null when the failing call was not observed. */
  tool: string | null
  /** Failing result text, clipped to the configured character budget. */
  message: string
  /** Times this exact tool-and-message failure was observed in the session. */
  count: number
  /** ISO-8601 instant of the first observation. */
  firstAt: string
  /** ISO-8601 instant of the most recent observation. */
  lastAt: string
}

/** Durable failure observations for one session. */
export interface FeedbackRecord {
  /** Newest-first retained observations, capped by `maxEntries`. */
  entries: readonly FeedbackEntry[]
  /** ISO-8601 instant of the last write. */
  updatedAt: string
}

/** One failure aggregated across the summarized sessions. */
export interface FeedbackSummaryEntry extends FeedbackEntry {
  /** Distinct sessions that reported this failure. */
  sessions: number
}
