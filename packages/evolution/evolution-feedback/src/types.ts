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

/** How decisive a signal is for a state transition. */
export type FeedbackActionability = 'observe_only' | 'ranking_only' | 'trigger_review'

/** Whether there is enough evidence to attribute a failure to a specific tool. */
export type FeedbackEvidenceStatus = 'complete' | 'actionable_partial'

/** One aggregated failure, with its evidence grade attached. */
export interface FeedbackSignal extends FeedbackSummaryEntry {
  /** Whether the failure decides a transition, only ranks, or merely observes. */
  actionability: FeedbackActionability
  /** Whether the failing call itself was observable. */
  evidenceStatus: FeedbackEvidenceStatus
  /** Tool-and-message identity this failure merges under. */
  mergeKey: string
}

/**
 * Analytic fields of a reflection: stated by an analyst through
 * `recordReflection`, or authored from the observed failure by
 * `reflectSignals`. A field a deterministic author cannot know stays null
 * rather than being guessed.
 */
export interface ReflectionAnalysis {
  /** What actually caused the failure; null when nothing stated it. */
  rootCause: string | null
  /** What to do instead next time; null when nothing stated it. */
  correctedStrategy: string | null
  /** Condition under which the corrected strategy applies; null when nothing stated it. */
  reusableWhen: string | null
  /** Named misuse to avoid, with its trigger condition; null when nothing stated it. */
  antiPattern: string | null
  /** Check that would have caught the failure; null when nothing stated it. */
  candidateTest: string | null
}

/** Ledger facts about how one failure behaved. */
export interface ReflectionFailure {
  /** Times the failure was observed across the reflected sessions. */
  count: number
  /** Distinct sessions that reported the failure. */
  sessions: number
  /** ISO-8601 instant of the first observation. */
  firstAt: string
  /** ISO-8601 instant of the most recent observation. */
  lastAt: string
}

/**
 * One structured reflection: the ledger-derived half of the schema plus the
 * analytic half. Derived fields are never null; analytic fields stay null
 * until something states them, so a reader can tell measured fact from missing
 * analysis at a glance.
 */
export interface StructuredReflection {
  /** Tool-and-message identity this reflection merges under. */
  failureId: string
  /** Failing result text, as observed. */
  symptom: string
  /** What the run expected instead of the symptom. */
  violatedExpectation: string
  /** What actually caused the failure; null when nothing stated it. */
  rootCause: string | null
  /** Session ids that reported the failure, sorted: the observed contexts. */
  contributingFactors: readonly string[]
  /** What already works despite the failure; null: only an analyst can see it. */
  whatWorked: string | null
  /** How the failure behaved across the reflected sessions. */
  whatFailed: ReflectionFailure
  /** What to do instead next time; null when nothing stated it. */
  correctedStrategy: string | null
  /**
   * Confidence in [0, 1] from the evidence behind the failure: 0.25 when the
   * failing call was never observed, otherwise three quarters the distinct-
   * session share and one quarter the recurrence share, both measured against
   * `triggerReviewSessions`, so independent support dominates and repetition
   * within one session cannot stand in for a second session (§20).
   */
  confidence: number
  /** Condition under which the corrected strategy applies; null when nothing stated it. */
  reusableWhen: string | null
  /** Named misuse to avoid, with its trigger condition; null when nothing stated it. */
  antiPattern: string | null
  /** Check that would have caught the failure; null when nothing stated it. */
  candidateTest: string | null
}

/** Durable analytic half of one reflection, keyed by merge key. */
export interface ReflectionRecord extends ReflectionAnalysis {
  /** ISO-8601 instant of the last analysis write. */
  updatedAt: string
}
