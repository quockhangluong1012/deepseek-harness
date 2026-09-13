/**
 * Timeline vocabulary of `/journey`: the deltas, calendar buckets, cumulative
 * capacity, and pending approvals the read model produces and the Remote
 * controller serves. Types only — no runtime code — so the Remote wire face and
 * browser consumers can import it without pulling the host command plugin.
 * @module @deepseek-ai/dsh-command-evolution/types
 */

import type { UsageRange } from '@deepseek-ai/dsh-usage-ledger/types'

/** What one delta records. */
export type TimelineDeltaKind = 'instructions' | 'lessons' | 'profile' | 'context' | 'outputs' | 'staged'

/** One recorded change in the scope, placed on its calendar day. */
export interface TimelineDelta {
  /** `YYYY-MM-DD` in UTC+7. */
  day: string
  /** Which part of the record moved. */
  kind: TimelineDeltaKind
  /** One-line account naming the change (origin, path, label, or staged gist). */
  gist: string
  /** Session the change is attributable to, or null when the record carries none. */
  sessionId: string | null
  /** ISO-8601 instant of the change. */
  at: string
}

/** One calendar day of the range, zero-filled when it holds no activity. */
export interface TimelineDayBucket {
  /** `YYYY-MM-DD` in UTC+7. */
  day: string
  /** Recorded changes that day, ascending by instant. */
  deltas: TimelineDelta[]
  /** Context items attached that day. */
  contextAttached: number
  /** Produced files indexed that day. */
  outputsIndexed: number
  /** Staged writes opened that day. */
  stagedOpened: number
  /** Staged writes approved that day. */
  stagedApproved: number
  /** Staged writes rejected that day. */
  stagedRejected: number
}

/** Where the scope stands now, independent of the range. */
export interface TimelineCumulative {
  /** Charged bytes across instructions, lessons, profile, and context. */
  usedBytes: number
  /** Configured capacity ceiling. */
  capacityBytes: number
  /** Digest of the brief's current inputs. */
  digest: string
  /** UTF-8 bytes of the lessons document. */
  lessonsBytes: number
  /** UTF-8 bytes of the user-profile document. */
  profileBytes: number
}

/** One staged write awaiting approval. */
export interface TimelinePending {
  /** Staged entry identity. */
  id: string
  /** Whether the entry writes memory or a skill. */
  kind: 'memory' | 'skill'
  /** Operation the entry would apply. */
  op: string
  /** One-line summary carried by the entry. */
  gist: string
  /** Session that proposed the entry. */
  originSessionId: string
  /** ISO-8601 instant the entry was staged. */
  createdAt: string
}

/** The scope's journey over one range. */
export interface JourneyTimeline {
  /** Requested window. */
  range: UsageRange
  /** Clock the window was computed against (Unix epoch milliseconds). */
  now: number
  /** Days of the range, ascending; zero-filled for bounded ranges, data-only for `all`. */
  days: TimelineDayBucket[]
  /** Current capacity, digest, and document sizes. */
  cumulative: TimelineCumulative
  /** Staged writes still awaiting a decision. */
  pending: TimelinePending[]
}
