/**
 * The six-signal composite of the OpenClaw dreaming algorithm. The weights are
 * part of the algorithm, not a deployment choice, so they are constants here;
 * every signal is normalized to `0..1` by a saturating map so no signal can
 * dominate the sum by carrying an unbounded raw count.
 * @module @deepseek-ai/dsh-evolution-dreaming/signals
 */

/** Per-dimension contributions of one scored candidate. */
export interface DreamSignals {
  /** Semantic similarity to the scope's existing memory. */
  relevance: number
  /** How often the candidate has surfaced. */
  frequency: number
  /** Distinct session contexts that reported it. */
  queryDiversity: number
  /** Time-decayed freshness of the last sighting. */
  recency: number
  /** Whether it stayed stable across multiple days. */
  integration: number
  /** Distinct concept density of the statement. */
  conceptRichness: number
}

/**
 * Fixed weights of the composite. Summed they are exactly 1, so a candidate
 * perfect on every dimension scores 1.
 */
export const DREAM_WEIGHTS: Readonly<Record<keyof DreamSignals, number>> = {
  relevance: 0.30,
  frequency: 0.24,
  queryDiversity: 0.15,
  recency: 0.15,
  integration: 0.10,
  conceptRichness: 0.06,
}

/** Observations behind one candidate, at the instant it is scored. */
export interface CandidateEvidence {
  /** Similarity to the scope's existing memory, already normalized to `0..1`. */
  relevance: number
  /** Times this failure was observed across the summarized sessions. */
  count: number
  /** Distinct sessions that reported it. */
  sessions: number
  /** ISO-8601 instant of the first observation. */
  firstAt: string
  /** ISO-8601 instant of the most recent observation. */
  lastAt: string
  /** Distinct words in the candidate statement. */
  concepts: number
  /** Epoch milliseconds the score is evaluated at. */
  now: number
}

/** Sighting count at which the frequency signal reaches one half. */
export const FREQUENCY_HALF_POINT = 3

/** Distinct-session count at which the query-diversity signal reaches one half. */
const DIVERSITY_HALF_POINT = 2

/** Days over which recency halves. */
const RECENCY_HALF_LIFE_DAYS = 30

/** Days of stability across which the integration signal reaches its ceiling. */
const INTEGRATION_FULL_DAYS = 7

/** Distinct concepts at which the richness signal reaches its ceiling. */
const CONCEPTS_FULL = 12

const MS_PER_DAY = 86_400_000

/** Saturating map `n / (n + halfPoint)`: 0 at 0, one half at the half point. */
function saturate(value: number, halfPoint: number): number {
  const bounded = Math.max(0, value)
  return bounded / (bounded + halfPoint)
}

/** Clamp a similarity that a caller may pass outside `0..1`. */
function unit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Elapsed whole days between two instants, never negative for a clock that stepped back. */
function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / MS_PER_DAY)
}

/**
 * Score one candidate with the six-signal weighted composite. Each signal is
 * normalized before weighting: frequency and query diversity saturate so a
 * single very loud failure cannot outweigh one seen in many contexts, recency
 * halves every 30 days, integration rises with the span it stayed observed,
 * and richness saturates at a dozen distinct concepts.
 * @param evidence - the candidate's observations and the scoring instant.
 * @returns the composite in `0..1` and its per-dimension contributions.
 */
export function scoreCandidate(evidence: CandidateEvidence): { score: number; signals: DreamSignals } {
  const lastMs = Date.parse(evidence.lastAt)
  const firstMs = Date.parse(evidence.firstAt)
  const signals: DreamSignals = {
    relevance: unit(evidence.relevance),
    frequency: saturate(evidence.count, FREQUENCY_HALF_POINT),
    queryDiversity: saturate(evidence.sessions, DIVERSITY_HALF_POINT),
    // A future timestamp (a clock that stepped back between writes) reads as
    // maximally fresh rather than as a negative age.
    recency: Math.pow(2, -daysBetween(lastMs, evidence.now) / RECENCY_HALF_LIFE_DAYS),
    integration: Math.min(1, daysBetween(firstMs, lastMs) / INTEGRATION_FULL_DAYS),
    conceptRichness: Math.min(1, Math.max(0, evidence.concepts) / CONCEPTS_FULL),
  }
  let score = 0
  for (const [dimension, weight] of Object.entries(DREAM_WEIGHTS) as Array<[keyof DreamSignals, number]>) {
    score += signals[dimension] * weight
  }
  return { score, signals }
}

/**
 * Distinct whole words in a statement, used for the concept-richness signal.
 * @param statement - the text to tokenize.
 * @returns how many distinct words of two or more letters or digits it carries.
 */
export function countConcepts(statement: string): number {
  const words = statement.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu)
  return words === null ? 0 : new Set(words).size
}

/**
 * Concept overlap between two texts: the words they share over the words either
 * one carries. This is the lexical stand-in for a semantic comparison, and both
 * callers — the relevance signal and the restatement rule — take the number as
 * it comes, so a deployment that mounts an embedding provider replaces it in
 * one place.
 * @param left - first text.
 * @param right - second text.
 * @returns the shared share of their distinct words in `0..1`.
 */
export function conceptOverlap(left: string, right: string): number {
  const leftWords = new Set(left.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])
  const rightWords = new Set(right.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])
  if (leftWords.size === 0 || rightWords.size === 0) return 0
  let shared = 0
  for (const word of leftWords) if (rightWords.has(word)) shared += 1
  return shared / (leftWords.size + rightWords.size - shared)
}
