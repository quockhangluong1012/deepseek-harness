/**
 * Bounded, time-limited cache of derived-index search pages.
 *
 * A page is keyed by the corpus generation it was read from, so a changed
 * corpus produces a different key rather than a stale hit: correctness comes
 * from the key, and the bounds only decide how long an answer stays available.
 * A hit can therefore never disagree with the index the caller asked about —
 * the worst case is that an old entry occupies room until it ages out.
 * @module @deepseek-ai/dsh-session-query-sqlite/result-cache
 */

/** Bounds and lifetime of one cache. */
export interface SessionResultCacheLimits {
  /** Entries retained before the least recently used is dropped. */
  maxEntries: number
  /** Milliseconds an entry stays answerable after it was stored. */
  ttlMs: number
}

/** One stored page with the instant it was written. */
interface CacheEntry<T> {
  at: number
  value: readonly T[]
}

/** Least-recently-used cache of search pages, bounded by count and by age. */
export class SessionResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private readonly limits: SessionResultCacheLimits

  /**
   * @param limits - entry bound and lifetime.
   */
  constructor(limits: SessionResultCacheLimits) {
    this.limits = limits
  }

  /**
   * Answer one key if it is still held and still fresh.
   * @param key - page identity, including the corpus generation it was read from.
   * @param now - epoch milliseconds the lookup happens at.
   * @returns the stored page, or undefined on a miss or an expired entry.
   */
  get(key: string, now: number): readonly T[] | undefined {
    const held = this.entries.get(key)
    if (held === undefined) return undefined
    if (now - held.at > this.limits.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    // Re-insert so the most recently used entry is the last key.
    this.entries.delete(key)
    this.entries.set(key, held)
    return held.value
  }

  /**
   * Store one page, dropping the least recently used entry past the bound.
   * @param key - page identity.
   * @param value - the page to retain.
   * @param now - epoch milliseconds the page was read at.
   */
  set(key: string, value: readonly T[], now: number): void {
    this.entries.delete(key)
    this.entries.set(key, { at: now, value })
    if (this.entries.size <= this.limits.maxEntries) return
    const oldest = this.entries.keys().next().value
    /* v8 ignore next -- a map larger than a positive bound has a first key */
    if (oldest !== undefined) this.entries.delete(oldest)
  }

  /** Drop every entry, used when the underlying index is released. */
  clear(): void {
    this.entries.clear()
  }

  /** Entries currently held, for diagnostics. */
  get size(): number {
    return this.entries.size
  }
}
